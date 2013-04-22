# inflate

streaming inflate in pure javascript (as a [through](http://npm.im/through) stream).

the source code [is annotated](http://didact.us/inflate/). be forewarned, it is full of
bats and rusty nails and goblins and things.

```javascript
var inflate = require('inflate')

your_input
  .pipe(inflate())
  .on('unused', function(unused_buffer, num_bytes_read) {

  })
  .pipe(your_output)

```

## API

#### inflate() -> inflate stream

create an inflate stream. each inflate stream carries a 32k memory overhead (for the window).

#### inflate.recycle() -> inflate stream

create a new inflate stream that recycles the output window (and JIT warmup) from the previous
inflate stream.

## history

[here's the starting point, and then an intermediate point on the way to this package.](https://gist.github.com/chrisdickinson/a5feecd1906b15638d50)

## License

MIT
