const http = require ( 'http' );
const request = require ( 'request' );
const createHandler = require ( 'github-webhook-handler' );
const url = require( 'url' );

const calypsoProject = 'Automattic/wp-e2e-tests-gh-bridge';
const e2eTestsProject = 'Automattic/wp-e2e-tests-for-branches';
const e2eTestsBranch = 'try/triggering-from-other-project';
const executionLabel = '[Status] Needs Review';

const triggerBuildURL = `https://circleci.com/api/v1.1/project/github/${ e2eTestsProject }/tree/${ e2eTestsBranch }?circle-token=${ process.env.CIRCLECI_SECRET}`;
const gitHubStatusURL = `https://api.github.com/repos/${ calypsoProject }/statuses/`;

const gitHubWebHookPath = '/ghwebhook';
const circleCIWebHookPath = '/circleciwebhook';

const prContext = 'ci/e2e-canary-tests';


const handler = createHandler( { path: gitHubWebHookPath, secret: process.env.BRIDGE_SECRET } );

http.createServer(function (req, res) {
    const fullUrl = req.url;
    const path = fullUrl.split( '?' )[0];
    if ( path === gitHubWebHookPath ) {
        handler(req, res, function (err) {
            res.statusCode = 404;
            res.end('invalid location');
        });
    } else if ( path === circleCIWebHookPath ) {
        console.log( "Called from CircleCI" );
        let body = [];
        req.on( 'data', function( chunk ) {
            body.push( chunk );
        } ).on( 'end', function() {
            body = Buffer.concat( body ).toString();
            try {
                let payload = JSON.parse( body ).payload;
                if ( payload && payload.build_parameters && payload.build_parameters.sha ) {
                    let status = 'success';
                    let desc = 'Your PR passed the e2e canary tests on CircleCI!';
                    if ( payload.status !== 'success' ) {
                        status = 'failure';
                        desc = `Canary test status: ${payload.status}`;
                    }

                    // POST to GitHub to provide status
                    let gitHubStatus = {
                        state: status,
                        description: desc,
                        target_url: payload.build_url,
                        context: prContext
                    };
                    request.post( {
                        headers: { Authorization: 'token ' + process.env.GITHUB_SECRET, 'User-Agent': 'wp-e2e-tests-gh-bridge' },
                        url: gitHubStatusURL + payload.build_parameters.sha,
                        body: JSON.stringify( gitHubStatus )
                    }, function( error ) {
                        if ( error ) {
                            console.log( `ERROR: ${error}` );
                        }
                        console.log( 'GitHub status updated' );
                    } );
                }
            } catch ( e ) {
                console.log( 'Non-CircleCI packet received' );
            }
            res.statusCode = 200;
            res.end( 'ok' );
        } );
    } else {
        console.log( 'unknown location', fullUrl );
        res.statusCode = 404;
        res.end( 'no such location' );
    }
}).listen( process.env.PORT || 7777 );

handler.on('error', function (err) {
    console.error('Error:', err.message);
});

handler.on('pull_request', function (event) {
    if ( event.payload.repository.full_name === calypsoProject && event.payload.action === 'labeled' && event.payload.label.name === executionLabel ) {
        const branchName = event.payload.pull_request.head.ref;
        console.log( 'Executing e2e canary tests for branch: \'' + branchName + '\'' );

        const sha = event.payload.pull_request.head.sha;
        const pullRequestNum = event.payload.pull_request.number;

        const buildParameters = {
            build_parameters: {
                liveBranches: 'true',
                branchName: branchName,
                sha: sha,
                pullRequestNum: pullRequestNum
            }
        };

        // POST to CircleCI to initiate the build
        request.post( {
            headers: {'content-type': 'application/json', accept: 'application/json'},
            url: triggerBuildURL,
            body: JSON.stringify( buildParameters )
        } , function( error, response ) {
            if ( response.statusCode === 201 ) {
                console.log( 'Tests have been kicked off - updating PR status now' );
                // Post status to Github
                const gitHubStatus = {
                    state: 'pending',
                    target_url: JSON.parse( response.body ).build_url,
                    context: prContext,
                    description: 'The e2e canary tests are running against your PR'
                };
                request.post( {
                    headers: { Authorization: 'token ' + process.env.GITHUB_SECRET, 'User-Agent': 'wp-e2e-tests-gh-bridge' },
                    url: gitHubStatusURL + sha,
                    body: JSON.stringify( gitHubStatus )
                }, function( responseError ) {
                    if ( responseError ) {
                        console.log( 'ERROR: ' + responseError  );
                    }
                    console.log( 'GitHub status updated' );
                } );
            }
            else
            {
                // Something went wrong - TODO: post message to the Pull Request about
                console.log( 'Something went wrong with executing e2e tests' );
                console.log( 'ERROR::' + error );
                console.log( 'RESPONSE::' + JSON.stringify( response ) );
            }
        } );
    }
});
