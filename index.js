module.exports = inflate

var through = require('through')
  , Buffer = require('buffer').Buffer

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

var WINDOW = 32768
  , WINDOW_MINUS_ONE = WINDOW - 1

function inflate() {
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

  var bitbuf = 0
    , bitcnt = 0
    , is_final = false
    , fixed_codes

  var adler_s1 = 1
    , adler_s2 = 0

  var _call_header
    , _call_bytes
    , _call_bits
    , _call_codes
    , _call_dynamic
    , _call_decode

  stream.once('resume', function() {
    execute()
  })

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

  become(noop, {}, noop)
  start_stream_header()

  return stream

  function noop() {

  }

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

  function execute() {
    while(1) {
      var last = states[0].current
      states[0].current()
      if(need_input || ended) {
        break
      }
    }
    need_input = false
  }

  function start_stream_header() {
    become(bytes, call_bytes(2), got_stream_header)
  }

  function got_stream_header() {
    var cmf = state.last[0]
      , flg = state.last[1]


    if((cmf << 8 | flg) % 31 !== 0) {
      stream.emit('error', new Error(
        'failed header check'
      ))
      return
    }

    if(flg & 32) {
      return become(bytes, call_bytes(4), on_got_fdict)
    }
    return become(bits, call_bits(1), on_got_is_final)
  }

  function on_got_fdict() {
    return become(bits, call_bits(1), on_got_is_final)
  }

  function on_got_is_final() {
    is_final = state.last
    become(bits, call_bits(2), on_got_type)
  }

  function on_got_type() {
    if(state.last === 0) {
      become(bytes, call_bytes(4), on_got_len_nlen)
      return
    }

    if(state.last === 1) {
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

  function on_got_stored() {
    output_many(state.last)
    if(is_final) {
      become(bytes, call_bytes(4), on_got_adler)
      return
    }
    become(bits, call_bits(1), on_got_is_final)
  }

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

    if(symbol < 256) {
      output_one(symbol)
      become(decode, call_decode(state.lencode), on_got_codes_symbol)
      return
    }

    if(symbol > 256) {
      symbol = state.symbol -= 257
      if(symbol >= 29) {
        stream.emit('error', new Error('invalid fixed code'))
        return
      }

      become(bits, call_bits(lext[symbol]), on_got_codes_len)
      return
    }

    if(symbol === 256) {
      unbecome()
      return
    }
  }

  function on_got_codes_len() {
    state.len = lens[state.symbol] + state.last
    become(decode, call_decode(state.distcode), on_got_codes_dist_symbol)
  }

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

  function bits() {
    var byt
      , idx

    idx = 0
    state.value = bitbuf
    while(bitcnt < state.need) {
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
      if(output_idx === WINDOW) {
        output_idx &= WINDOW_MINUS_ONE
      }
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
