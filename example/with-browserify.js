var inflate = require('./index')
  , domnode = require('domnode-dom')
  , through = require('through')

var xhr = new XMLHttpRequest
  , output = document.createElement('pre')
  , stdout = through(_stdout)
  , stdin = through()

document.body.appendChild(output)

stdin.pipe(inflate()).pipe(stdout)

xhr.open('GET', '/index.js.z')  
xhr.responseType = 'arraybuffer'
xhr.onreadystatechange = function() {
  if(xhr.readyState != 4) return

  start(xhr.response)
}
xhr.send(null)

function _stdout(buf) {
  output.appendChild(document.createTextNode(buf+''))
}

// chunk up the arraybuffer
//
function start(binary) {
  var offset = 0
    , chunksize = 2048  // <-- capriciously chosen
    , self = this
    , next

  // turn ourselves into typed data.
  binary = new Uint8Array(binary)
  iter()

  function iter() {
    next = Math.min(binary.length, offset + chunksize)

    stdin.write(
      new Buffer(binary.subarray(offset, next))
    )

    offset = next
    if(offset === binary.length) {
      return
    } 
    process.nextTick(iter)
  }
}
