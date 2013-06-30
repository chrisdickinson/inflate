module.exports = inflate

var min = pushToPull(require('./min'))
  , through = require('through')

function inflate() {
  var stream = through(write, end)
    , inner = min(read)
    , accum = []
    , cb

  iter()

  return stream

  function iter() {
    inner(null, function(err, data) {
      if(err) {
        stream.emit('error', err)
        return
      }
      if(data === undefined) {
        stream.queue(null)
        return
      }
      stream.queue(data)
      iter()
    })
  }

  function write(buf) {
    accum.push(buf)
    if(!cb) {
      return
    }

    while(accum.length) {
      cb(null, accum.shift())
    }
  }

  function end() {
  }

  function read(close, callback) {
    if(close) {
      if(close === true) { 
        stream.queue(null)
      } else {
        stream.emit('error', close)
      }
      return
    }

    cb = callback
  }
}

function pushToPull(push) {
  return function (read) {
    var dataQueue = []
    var readQueue = []
    var reading = false
    var emit = push(function () {
      dataQueue.push(arguments)
      check()
    })

    function check() {
      while (dataQueue.length && readQueue.length) {
        readQueue.shift().apply(null, dataQueue.shift())
      }
      if (!reading && readQueue.length) {
        reading = true
        read(null, onRead)
      }
    }

    function onRead(err, item) {
      reading = false
      emit(err, item)
      check()
    }

    return function (close, callback) {
      if (close) {
        return read(close, callback)
      }
      readQueue.push(callback)
      check()
    }
  }
}
