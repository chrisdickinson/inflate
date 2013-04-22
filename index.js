module.exports = inflate

// # inflate
//
// a tale in several (horrifying?) parts.
// first things first: infinite thanks to Mark Adler's 
// [puff.c](http://svn.ghostscript.com/ghostscript/trunk/gs/zlib/contrib/puff/puff.c) 
// which provided the basis for the first version of this code (available under the
// ZLIB license).
//
// And, of course, the [RFC](http://www.ietf.org/rfc/rfc1950.txt) makes for
// some cozy bedtime reading.
//
// To start with, let's require @dominictarr's [through](http://npm.im/through).
// It simplifies stream creation in Node.JS 0.8.X, and is compatible with newer Node.JS
// versions.
var through = require('through')
  , Buffer = require('buffer').Buffer

// Some constants. If you'd like to let your page slowly scroll down and go get some
// coffee now, I wouldn't mind. I'll wait.
var MAXBITS = 15
  , MAXLCODES = 286
  , MAXDCODES = 30
  , MAXCODES = (MAXLCODES+MAXDCODES)
  , FIXLCODES = 288

var lens = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
  35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258
]

var lext = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
  3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0
]

var dists = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
  257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145,
  8193, 12289, 16385, 24577
]

var dext = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
  7, 7, 8, 8, 9, 9, 10, 10, 11, 11,
  12, 12, 13, 13
]

var order = [
  16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15
]

// So, inflate is predicated on the idea that we're able to reach
// back into things we've previously output to create new output --
// that is, if we output "tree" at some point, instead of ever having
// to include the literal word "tree" again in bytes, we can simply
// refer to it using the magic of the `lencode` / `distcode` huffman
// trees.
//
// This means that, at minimum, to produce the desired output from a
// deflated stream, we must have at least as big of an output window
// as was used to *create* the stream. It just so happens that 32768
// bytes is the largest size (AFAIK), so we set that here.
var WINDOW = 32768
  , WINDOW_MINUS_ONE = WINDOW - 1

function inflate() {
  // Initialize the output window, the stream itself,
  // as well as other bookkeeping.
  //
  // * `buffer` keeps a list of all `Buffer` instances received
  //   by `write`. We drop buffers out of that list when we've 
  //   exhausted them (slicing each buffer each time would create
  //   too much garbage, and in newer versions of browserify, "slice"
  //   incurs a copy operation -- which would kill perf.)
  // * `buffer_offset` tells us how far into the current input we are.
  //   once `buffer_offset === buffer[0].length`, we shift that input off
  //   the stack.
  // * `bytes_read` lets us tally the number of bytes we've seen so we can
  //   report the final compressed length at the end of the stream.
  // * `output` is our giant blob of output, and `output_idx` keeps track
  //   of our offset within it. We'll use modulos (well, bitwise modulos)
  //   to ping back and forth within it and avoid unnecessary garbage creation.
  var output = new Uint8Array(WINDOW)
    , stream = through(write, end)
    , need_input = false
    , buffer_offset = 0
    , bytes_read = 0
    , output_idx = 0
    , ended = false
    , state = null
    , states = []
    , buffer = []
    , got = 0

  // We're going to be reading a lot of individual bits.
  // `bitcnt` keeps track of how many bits we have available
  // to us, while `bitbuf` stores the remainder of the last byte
  // that we didn't read.
  // `is_final` keeps track of whether the current zlib block is
  // the last in the stream. Finally, `fixed_codes` is the memoization
  // of a call to `fixed`, essentially.
  var bitbuf = 0
    , bitcnt = 0
    , is_final = false
    , fixed_codes

  // Oh, and we're checksumming everything we output to make sure
  // that when we get to the 4-byte adler check at the end of the stream,
  // we're prepared to say whether or not we were just lying through our
  // horrible, streaming teeth when we were producing output earlier.
  var adler_s1 = 1
    , adler_s2 = 0

  // These are here to pique your interest and as a side effect
  // prevent some global leakage. Mystery abounds!
  var _call_header
    , _call_bytes
    , _call_bits
    , _call_codes
    , _call_dynamic
    , _call_decode

  // If at any point our stream pauses (the next item in the chain
  // of pipes can't accept any data at the moment), we'll need to be
  // able to start executing again once it drains. This `resume` listener
  // sets up that behavior.
  stream.on('resume', function() {
    execute()
  })

  // Sort of an aside:
  // When you define functions-within-a-function, they really,
  // truly are new instances of functions. Calling the parent again
  // will instruct JS to dutifully rebuild all of them in new memory
  // locations -- importantly, this means *they do not share optimizations*.
  // So if you can't recycle the stream's warmed-up, JIT'd functions,
  // you're doomed to JIT them again and again.
  //
  // Also, we're keeping 32K of memory around! May as well reuse that so
  // the GC doesn't have a field day and slurp up all of our cycles.
  stream.recycle = function recycle() {
    var out
    buffer.length = 0
    buffer_offset = 0
    output_idx = 0
    bitbuf = 0
    bitcnt = 0
    states.length = 0
    is_final = false
    need_input = false
    bytes_read = 0
    output_idx = 0
    ended = false
    state = null
    got = 0
    adler_s1 = 1
    adler_s2 = 0
    become(noop, {}, noop)
    start_stream_header()
    out = through(write, end)
    out.recycle = recycle
    return out
  }

  // The mystery deepens.
  _call_header = {
    last: null
  }

  _call_bytes = {
    need: 0
  , value: []
  , last: null
  }

  _call_bits = {
    need: 0
  , value: []
  , last: null
  }

  _call_codes = {
      distcode: null
    , lencode: null
    , len: 0
    , dist: 0
    , symbol: 0
    , last: null
  }

  _call_dynamic = {
      distcode: {symbol: [], count: []}
    , lencode: {symbol: [], count: []}
    , lengths: []
    , nlen: 0
    , ndist: 0
    , ncode: 0
    , index: 0
    , symbol: 0
    , len: 0
    , last: 0
  }

  _call_decode = {
      huffman: null
    , len: 0
    , code: 0
    , first: 0
    , count: 0
    , index: 0
    , last: 0
  }

  // Okay, cool. We're just about ready to hand back the stream.
  // Set it up so that the first thing it does is to look for
  // a stream header, and then cough up the stream.
  become(noop, {}, noop)
  start_stream_header()

  return stream

  // The most valuable function in all of programming
  // history.
  function noop() {

  }

  // ## calling things.
  //
  // This kills the suspense I've built up over the course
  // of the last few comments. An explanation of our `_call_*`-y
  // friends:
  //
  // Common wisdom when writing an API that may *some* of the time
  // be synchronous and *some* of the time be asynchronous is to
  // simply use `setTimeout` (or `setImmediate` in its various 
  // incarnations) to make it async **all** of the time.
  //
  // The problem is that yielding back to the event loop isn't free --
  // it takes time. When you're dealing with something that is *usually*
  // synchronous -- on the order of like, 90% of the time you'll have
  // everything you need to complete a call -- waiting for the next event
  // loop turn adds up to a lifetime's worth of wasted time.
  //
  // The next solution is to simply use callbacks directly! Instead of
  // using `process.nextTick` and friends, you simply call the callback in
  // the same turn!
  //
  // That'll work for some range of inputs -- specifically, when you know
  // that you'll never be recursing more than <Maximum Recursion Depth> times
  // in a single frame -- and you have a particular unerring trust in whoever
  // is using your library (i.e., you don't expect to be several levels deep
  // already!). But if the problem is truly such that it's **usually** synchronous,
  // you'll run into `RecursionError`s galore.
  //
  // So instead, we're going to write a poor man's stack with TCO. For bonus points,
  // instead of allocating new stack objects for each call, we'll reuse the same set
  // over every call to these functions. The following functions setup the appropriate
  // initial state for each call; while `become` and `unbecome` let us say "do this, then
  // become this once you're done". It also handles the async case for us -- the assumption
  // is that since we've got a stack of states around, we simply "resume" whenever we get
  // more data -- which means that all of our states have to be tolerant of re-entrance.
  function call_header() {
    return _call_header
  }

  function call_bytes(need) {
    _call_bytes.value.length = 0
    _call_bytes.need = need
    return _call_bytes
  }

  function call_bits(need) {
    _call_bits.value = 0
    _call_bits.need = need
    return _call_bits
  }

  function call_codes(distcode, lencode) {
    _call_codes.len =
    _call_codes.dist =
    _call_codes.symbol = 0
    _call_codes.distcode = distcode
    _call_codes.lencode = lencode
    return _call_codes
  }

  function call_dynamic() {
    _call_dynamic.distcode.symbol.length =
    _call_dynamic.distcode.count.length =
    _call_dynamic.lencode.symbol.length =
    _call_dynamic.lencode.count.length =
    _call_dynamic.lengths.length = 0
    _call_dynamic.nlen = 0
    _call_dynamic.ndist = 0
    _call_dynamic.ncode = 0
    _call_dynamic.index = 0
    _call_dynamic.symbol = 0
    _call_dynamic.len = 0
    return _call_dynamic
  }

  function call_decode(h) {
    _call_decode.huffman = h
    _call_decode.first = 
    _call_decode.index =
    _call_decode.index =
    _call_decode.code = 0

    _call_decode.len = 1
    return _call_decode
  }

  // Whenever we get data, we shove it onto the
  // list of input. So long as we haven't ended the
  // stream yet, we should try to get further along.
  function write(buf) {
    buffer.push(buf)
    got += buf.length
    if(!ended) {
      execute()
    }
  }

  function end() {
    stream.queue(null)
  }

  // The core of the functionality: when we get 
  // input (or resume), loop until we need input
  // or have ended the stream. Do work by pulling
  // the "latest" state off the stack, finding the
  // function that represents it, and executing it.
  // At the end of execution, reset the `need_input`
  // flag to its default state. 
  function execute() {
    do {
      states[0].current()
    } while(!need_input && !ended)
    need_input = false
  }

  function start_stream_header() {
    become(bytes, call_bytes(2), got_stream_header)
  }

  function got_stream_header() {
    var cmf = state.last[0]
      , flg = state.last[1]

    // make sure that the header as a 16bit int is a multiple of 31.
    if((cmf << 8 | flg) % 31 !== 0) {
      stream.emit('error', new Error(
        'failed header check'
      ))
      return
    }

    // if the fifth bit in "FLG" is set, then we should
    // expect an `FDICT`, which we largely ignore because
    // we are living free and unencumbered by reason.
    if(flg & 32) {
      return become(bytes, call_bytes(4), on_got_fdict)
    }
    return become(bits, call_bits(1), on_got_is_final)
  }

  function on_got_fdict() {
    // See? Told ya so. 
    // In reality this should give us an identifier to
    // prepopulate a huffman tree with(?)
    return become(bits, call_bits(1), on_got_is_final)
  }

  // ## The inflate block format
  //
  // There are three kinds of blocks -- fixed, dynamic,
  // and stored. We determine whether the block is the final
  // block in the stream by looking at the first bit we have
  // available to us. If it's 1, this is the last block, otherwise,
  // get ready for more blocks.
  function on_got_is_final() {
    is_final = state.last
    become(bits, call_bits(2), on_got_type)
  }

  // We then take 2 bits to determine the block type.
  // There are three possible types:
  //
  // * "stored": the simplest block type. discard the rest of this byte,
  //   and read 2 bytes representing the "length" of output following.
  //   then read 2 bytes representing the two's compliment of the length.
  //   (`len === ~nlen`), followed by <len> bytes of uncompressed
  //   output.
  // * "fixed": use pre-canned huffman trees to generate output.
  // * "dynamic": read the huffman trees from the stream, then use
  //   them to generate output.
  function on_got_type() {
    if(state.last === 0) {
      become(bytes, call_bytes(4), on_got_len_nlen)
      return
    }

    if(state.last === 1) {
      // `fixed` and `dynamic` blocks both eventually delegate
      // to the "codes" state -- which reads bits of input, throws
      // them into a huffman tree, and produces "symbols" of output.
      fixed_codes = fixed_codes || build_fixed()
      become(start_codes, call_codes(
        fixed_codes.distcode
      , fixed_codes.lencode
      ), done_with_codes)
      return
    }

    become(start_dynamic, call_dynamic(), done_with_codes)
    return
  }

  // Nothing too terribly surprising here.
  // Of note: `len` can be zero. This can be used to
  // byte-align other blocks. 
  function on_got_len_nlen() {
    var want = state.last[0] | (state.last[1] << 8)
      , nlen = state.last[2] | (state.last[3] << 8)

    if((~nlen & 0xFFFF) !== want) {
      return stream.emit('error', new Error(
        'failed len / nlen check'
      ))
    }

    if(!want) {
      become(bits, call_bits(1), on_got_is_final)
      return
    }
    become(bytes, call_bytes(want), on_got_stored)
  }

  // We now have the stored data. We should either
  // move on to checking that our checksum matches
  // the stream checksum, or to the next block.
  function on_got_stored() {
    output_many(state.last)
    if(is_final) {
      become(bytes, call_bytes(4), on_got_adler)
      return
    }
    become(bits, call_bits(1), on_got_is_final)
  }

  // for the next few functions, we read the huffman
  // trees out of the input stream. this part also happens
  // to give me a nosebleed.
  function start_dynamic() {
    become(bits, call_bits(5), on_got_nlen)
  }

  function on_got_nlen() {
    state.nlen = state.last + 257
    become(bits, call_bits(5), on_got_ndist)
  }

  function on_got_ndist() {
    state.ndist = state.last + 1
    become(bits, call_bits(4), on_got_ncode)
  }

  function on_got_ncode() {
    state.ncode = state.last + 4
    if(state.nlen > MAXLCODES || state.ndist > MAXDCODES) {
      stream.emit('error', new Error('bad counts'))
      return
    }

    become(bits, call_bits(3), on_got_lengths_part)
  }

  function on_got_lengths_part() {
    state.lengths[order[state.index]] = state.last

    ++state.index
    if(state.index === state.ncode) {
      for(; state.index < 19; ++state.index) {
        state.lengths[order[state.index]] = 0
      }

      // temporarily construct the `lencode` using the
      // lengths we've read. we'll actually be using the
      // symbols produced by throwing bits into the huffman
      // tree to constuct the `lencode` and `distcode` huffman
      // trees.
      construct(state.lencode, state.lengths, 19)
      state.index = 0

      become(decode, call_decode(state.lencode), on_got_dynamic_symbol_iter)
      return
    }
    become(bits, call_bits(3), on_got_lengths_part)
  }

  function on_got_dynamic_symbol_iter() {
    state.symbol = state.last

    if(state.symbol < 16) {
      state.lengths[state.index++] = state.symbol
      do_check()
      return
    }

    state.len = 0
    if(state.symbol === 16) {
      become(bits, call_bits(2), on_got_dynamic_symbol_16)
      return
    }

    if(state.symbol === 17) {
      become(bits, call_bits(3), on_got_dynamic_symbol_17)
      return
    }

    become(bits, call_bits(7), on_got_dynamic_symbol)
  }

  function on_got_dynamic_symbol_16() {
    state.len = state.lengths[state.index - 1]
    on_got_dynamic_symbol_17()
  }

  function on_got_dynamic_symbol_17() {
    state.symbol = 3 + state.last
    do_dynamic_end_loop()
  }

  function on_got_dynamic_symbol() {
    state.symbol = 11 + state.last
    do_dynamic_end_loop()
  }

  function do_dynamic_end_loop() {
    if(state.index + state.symbol > state.nlen + state.ndist) {
      stream.emit('error', new Error('too many lengths'))
      return
    }

    while(state.symbol--) {
      state.lengths[state.index++] = state.len
    }

    do_check()
  }

  function do_check() {
    if(state.index >= state.nlen + state.ndist) {
      end_read_dynamic()
      return
    }
    become(decode, call_decode(state.lencode), on_got_dynamic_symbol_iter)
  }

  function end_read_dynamic() {
    // okay, we can finally start reading data out of the stream.
    construct(state.lencode, state.lengths, state.nlen)
    construct(state.distcode, state.lengths.slice(state.nlen), state.ndist)
    become(start_codes, call_codes(
        state.distcode
      , state.lencode
    ), done_with_codes)
  }

  function start_codes() {
    become(decode, call_decode(state.lencode), on_got_codes_symbol)
  }

  function on_got_codes_symbol() {
    var symbol = state.symbol = state.last
    if(symbol < 0) {
      stream.emit('error', new Error('invalid symbol'))
      return
    }

    // literal output. in my experience, you'll usually see this
    // at the start of a stream so we can start "priming" the output
    // window for use later.
    if(symbol < 256) {
      output_one(symbol)
      become(decode, call_decode(state.lencode), on_got_codes_symbol)
      return
    }

    // this is fun. see `on_got_codes_len` for more.
    if(symbol > 256) {
      symbol = state.symbol -= 257
      if(symbol >= 29) {
        stream.emit('error', new Error('invalid fixed code'))
        return
      }

      become(bits, call_bits(lext[symbol]), on_got_codes_len)
      return
    }

    // 256 is a terminal symbol -- it means we're done with this block.
    if(symbol === 256) {
      unbecome()
      return
    }
  }

  // For symbols > 256 we subtract 257 (so they start at 0 again).
  // Then we use `lext` to see how many bits we need to read out of the stream
  // to represent the "extended length". Finally, we look at our hard-coded `lens`
  // table with that 0-indexed symbol to get the base length, and add our "extended
  // length" to that to get total length.
  function on_got_codes_len() {
    state.len = lens[state.symbol] + state.last
    become(decode, call_decode(state.distcode), on_got_codes_dist_symbol)
  }

  // We then pull out a "distance" in much the same fashion.
  function on_got_codes_dist_symbol() {
    state.symbol = state.last
    if(state.symbol < 0) {
      stream.emit('error', new Error('invalid distance symbol'))
      return
    }

    become(bits, call_bits(dext[state.symbol]), on_got_codes_dist_dist)
  }

  function on_got_codes_dist_dist() {
    var dist = dists[state.symbol] + state.last

    // Once we have a "distance" and a "length", we start to output bytes.
    // We reach "dist" back from our current output position to get the byte
    // we should repeat and output it (thus moving the output window cursor forward).
    // Two notes:
    //
    // 1. Theoretically we could overlap our output and input.
    // 2. `X % (2^N) == X & (2^N - 1)` with the distinction that
    //    the result of the bitwise AND won't be negative for the
    //    range of values we're feeding it. Spare a modulo, spoil the child.
    while(state.len--) {
      output_one(output[(output_idx - dist) & WINDOW_MINUS_ONE])
    }

    become(decode, call_decode(state.lencode), on_got_codes_symbol)
  }

  function done_with_codes() {
    if(is_final) {
      become(bytes, call_bytes(4), on_got_adler)
      return
    }
    become(bits, call_bits(1), on_got_is_final)
  }

  // We only call this once we're done with the last block. It's
  // just 4 bytes that should match up with what we've calculated
  // thus far for the adler checksum.
  function on_got_adler() {
    var check_s1 = state.last[3] | (state.last[2] << 8)
      , check_s2 = state.last[1] | (state.last[0] << 8)

    if(check_s2 !== adler_s2 || check_s1 !== adler_s1) {
      stream.emit('error', new Error(
        'bad adler checksum: '+[check_s2, adler_s2, check_s1, adler_s1]
      ))
      return
    } 

    ended = true

    stream.emit('unused', [buffer[0].slice(buffer_offset)].concat(buffer.slice(1)), bytes_read)
    output_idx = 0
    stream.queue(null)
  }

  // "decode" is the state where symbols are generated given
  // bits of input + a huffman tree.
  function decode() {
    _decode()
  }

  function _decode() {
    if(state.len > MAXBITS) {
      stream.emit('error', new Error('ran out of codes'))
      return
    }

    become(bits, call_bits(1), got_decode_bit)
  }

  function got_decode_bit() {
    state.code = (state.code | state.last) >>> 0
    state.count = state.huffman.count[state.len]
    if(state.code < state.first + state.count) {
      unbecome(state.huffman.symbol[state.index + (state.code - state.first)])
      return
    }
    state.index += state.count
    state.first += state.count
    state.first <<= 1
    state.code = (state.code << 1) >>> 0
    ++state.len
    _decode()
  }

  // The core of our "poor man's stack" functionality.
  function become(fn, s, then) {
    if(typeof then !== 'function') {
      throw new Error
    }
    states.unshift({
      current: fn
    , next: then
    , state: state = s
    })
  }

  function unbecome(result) {
    if(states.length > 1) {
      states[1].current = states[0].next
    }
    states.shift()
    if(!states.length) {
      ended = true

      stream.emit('unused', [buffer[0].slice(buffer_offset)].concat(buffer.slice(1)), bytes_read)
      output_idx = 0
      stream.queue(null)
      return
    }
    state = states[0].state
    state.last = result
  }

  // take N bits out of the stream (starting at the
  // current bit offset).
  function bits() {
    var byt
      , idx

    idx = 0
    state.value = bitbuf
    while(bitcnt < state.need) {
      // we do this to preserve `state.value` when
      // "need_input" is tripped.
      //
      // fun fact: if we moved that into the `if` statement
      // below, it would trigger a deoptimization of this (very
      // hot) function. JITs!
      bitbuf = state.value
      byt = take()
      if(need_input) {
        break
      }
      ++idx
      state.value = (state.value | (byt << bitcnt)) >>> 0
      bitcnt += 8
    }

    if(!need_input) {
      bitbuf = state.value >>> state.need
      bitcnt -= state.need
      unbecome((state.value & ((1 << state.need) - 1)) >>> 0)
    }
  }

  // take N bytes out of the stream, disregarding current bit
  // offset.
  function bytes() {
    var byte_accum = state.value
      , value

    while(state.need--) {
      value = take()
      if(need_input) {
        bitbuf = bitcnt = 0
        state.need += 1
        break
      }
      byte_accum[byte_accum.length] = value
    }
    if(!need_input) {
      bitcnt = bitbuf = 0
      unbecome(byte_accum)
    }
  }

  // `take` actually performs the "taking" of data from
  // the input stream (and setting of the `needs_input` flag).
  function take() {
    if(!buffer.length) {
      need_input = true
      return 
    }

    if(buffer_offset === buffer[0].length) {
      buffer.shift()
      buffer_offset = 0
      return take()
    }

    ++bytes_read
    return bitbuf = buffer[0].readUInt8(buffer_offset++)
  }

  // ### The output functions
  //
  // The output functions both output data as well as add it
  // to the current checksum.
  function output_one(val) {
    adler_s1 = (adler_s1 + val) % 65521
    adler_s2 = (adler_s2 + adler_s1) % 65521
    output[output_idx++] = val
    output_idx &= WINDOW_MINUS_ONE
    stream.queue(new Buffer([val]))
  }

  function output_many(vals) {
    var len
      , byt
      , olen

    for(var i = 0, len = vals.length; i < len; ++i) {
      byt = vals[i]
      adler_s1 = (adler_s1 + byt) % 65521
      adler_s2 = (adler_s2 + adler_s1) % 65521
      output[output_idx++] = byt
      output_idx &= WINDOW_MINUS_ONE
    }

    stream.queue(new Buffer(vals))
  }
}

function build_fixed() {
  var lencnt = []
    , lensym = []
    , distcnt = []
    , distsym = []

  var lencode = {
      count: lencnt
    , symbol: lensym
  }

  var distcode = {
      count: distcnt
    , symbol: distsym
  }

  var lengths = []
    , symbol

  for(symbol = 0; symbol < 144; ++symbol) {
    lengths[symbol] = 8
  }
  for(; symbol < 256; ++symbol) {
    lengths[symbol] = 9
  }
  for(; symbol < 280; ++symbol) {
    lengths[symbol] = 7
  }
  for(; symbol < FIXLCODES; ++symbol) {
    lengths[symbol] = 8
  }
  construct(lencode, lengths, FIXLCODES)

  for(symbol = 0; symbol < MAXDCODES; ++symbol) {
    lengths[symbol] = 5
  }
  construct(distcode, lengths, MAXDCODES)
  return {lencode: lencode, distcode: distcode}
}

function construct(huffman, lengths, num) {
  var symbol
    , left
    , offs
    , len

  offs = []

  for(len = 0; len <= MAXBITS; ++len) {
    huffman.count[len] = 0
  }

  for(symbol = 0; symbol < num; ++symbol) {
    huffman.count[lengths[symbol]] += 1
  }

  if(huffman.count[0] === num) {
    return
  }

  left = 1
  for(len = 1; len <= MAXBITS; ++len) {
    left <<= 1
    left -= huffman.count[len]
    if(left < 0) {
      return left
    }
  }

  offs[1] = 0
  for(len = 1; len < MAXBITS; ++len) {
    offs[len + 1] = offs[len] + huffman.count[len]
  }

  for(symbol = 0; symbol < num; ++symbol) {
    if(lengths[symbol] !== 0) {
      huffman.symbol[offs[lengths[symbol]]++] = symbol
    }
  }

  return left
}
