var http = require( 'http' );

var createHandler = require( 'github-webhook-handler' );
var handler = createHandler( { path: '/webhook', secret: process.env.BRIDGE_SECRET } );

http.createServer(function (req, res) {
    handler(req, res, function (err) {
        res.statusCode = 404;
        res.end('no such location');
    });
}).listen(7777);

handler.on('error', function (err) {
    console.error('Error:', err.message)
});

handler.on('pull_request', function (event) {
    console.log('Received a pull_request event of %s for %s as %s',
        event.payload.action,
        event.payload.number,
        event.payload.changes );
});
