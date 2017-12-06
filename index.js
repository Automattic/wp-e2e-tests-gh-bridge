const http = require ( 'http' );
const request = require ( 'request' );
const createHandler = require ( 'github-webhook-handler' );
const url = require( 'url' );

const calypsoProject = process.env.CALYPSO_PROJECT || 'Automattic/wp-calypso';
const e2eTestsMainProject = process.env.E2E_MAIN_PROJECT || 'Automattic/wp-e2e-tests';
const e2eTestsWrapperProject = process.env.E2E_WRAPPER_PROJECT || 'Automattic/wp-e2e-tests-for-branches';
const e2eTestsWrapperBranch = process.env.E2E_WRAPPER_BRANCH || 'master';
const flowPatrolOnly = process.env.FLOW_PATROL_ONLY || 'false';

const flowPatrolUsernames = [ 'alisterscott' ];
const triggerLabel = process.env.TRIGGER_LABEL || '[Status] Needs Review';

const triggerBuildURL = `https://circleci.com/api/v1.1/project/github/${ e2eTestsWrapperProject }/tree/${ e2eTestsWrapperBranch }?circle-token=${ process.env.CIRCLECI_SECRET}`;
const gitHubStatusURL = `https://api.github.com/repos/${ calypsoProject }/statuses/`;
const gitHubIssuessURL = `https://api.github.com/repos/${ calypsoProject }/issues/`;
const gitHubMainE2EBranchURL = `https://api.github.com/repos/${ e2eTestsMainProject }/branches/`;
const wpCalysoABTestsFile = 'client/lib/abtest/active-tests.js';

const gitHubWebHookPath = '/ghwebhook';
const circleCIWebHookPath = '/circleciwebhook';
const healthCheckPath = '/cache-healthcheck';

const prContext = 'ci/wp-e2e-tests-canary';

const handler = createHandler( { path: gitHubWebHookPath, secret: process.env.BRIDGE_SECRET } );

http.createServer(function (req, res) {
    const fullUrl = req.url;
    const path = fullUrl.split( '?' )[0];
    if ( path === gitHubWebHookPath ) {
        handler(req, res, function (err) {
            res.statusCode = 404;
            res.end('invalid location');
        });
    } else if ( path === healthCheckPath ) {
        res.statusCode = 200;
        res.end( 'OK' );
    } else if ( path === circleCIWebHookPath ) {
        console.log( "Called from CircleCI" );
        let body = [];
        req.on( 'data', function( chunk ) {
            body.push( chunk );
        } ).on( 'end', function() {
            body = Buffer.concat( body ).toString();
            try {
                let payload = JSON.parse( body ).payload;
                if ( payload && payload.build_parameters && payload.build_parameters.sha && payload.build_parameters.calypsoProject === calypsoProject ) {
                    let status, desc;
                    if (payload.outcome === 'success') {
                        status = 'success';
                        desc = 'Your PR passed the e2e canary tests on CircleCI!';
                    } else if (payload.outcome === 'failed') {
                        status = 'failure';
                        desc = `Canary test status: ${payload.status}`;
                    } else {
                        status = 'error';
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
    const pullRequestNum = event.payload.pull_request.number;
    const pullRequestStatus = event.payload.pull_request.state;
    const loggedInUsername = event.payload.sender.login;
    const pullRequestHeadLabel = event.payload.pull_request.head.label;
    const repositoryName = event.payload.repository.full_name;
    const action = event.payload.action;
    const prURL = event.payload.pull_request.url;

    // Check if we should only run for certain users
    if( flowPatrolOnly === 'true' && flowPatrolUsernames.indexOf( loggedInUsername ) === -1 ) {
        console.log(  `Ignoring pull request '${ pullRequestNum }' as we're only running for certain users and '${ loggedInUsername }' is not in '${ flowPatrolUsernames }'` );
        return true;
    }

    // Make sure the PR is in the correct repository
    if ( repositoryName !== calypsoProject ) {
        console.log(  `Ignoring pull request '${ pullRequestNum }' as the repository '${ repositoryName }' is not '${ calypsoProject }'` );
        return true;
    }

    // Make sure the PR is still open
    if ( pullRequestStatus !== 'open' ) {
        console.log(  `Ignoring pull request '${ pullRequestNum }' as the status '${ pullRequestStatus }' is not 'open'` );
        return true;
    }

    // Ignore OSS requests - check for location of head to indicate forks
    if ( event.payload.pull_request.head.label.indexOf( 'Automattic:' ) !== 0 ) {
        console.log(  `Ignoring pull request '${ pullRequestNum }' as this is from a fork: '${ pullRequestHeadLabel }'` );
        return true;
    }

    // canary test execution on label
    if ( action === 'labeled' && event.payload.label.name === triggerLabel ) {
        const branchName = event.payload.pull_request.head.ref;
        let e2eBranchName;
        console.log( 'Executing e2e canary tests for branch: \'' + branchName + '\'' );

        // Check if there's a matching branch in the main e2e test repository
        request.get( {
            headers: { Authorization: 'token ' + process.env.GITHUB_SECRET, 'User-Agent': 'wp-e2e-tests-gh-bridge' },
            url: gitHubMainE2EBranchURL + branchName,
        }, function( err, response ) {
            if ( response.statusCode === 200 ) {
                e2eBranchName = branchName;
            } else {
                e2eBranchName = 'master';
            }

            const sha = event.payload.pull_request.head.sha;

            const buildParameters = {
                build_parameters: {
                    LIVEBRANCHES: 'true',
                    BRANCHNAME: branchName,
                    E2E_BRANCH: e2eBranchName,
                    RUN_ARGS: '-b ' + branchName,
                    sha: sha,
                    pullRequestNum: pullRequestNum,
                    calypsoProject: calypsoProject
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
        } );
    }
    // Comment about A/B tests
    else if ( action === 'synchronize' || action === 'opened' ) {
        const comment = `It looks like you're updating the [active A/B tests](${ wpCalysoABTestsFile }). Can you please ensure our [automated e2e tests](https://github.com/${ e2eTestsMainProject }) know about this change? Instructions on how to do this are available [here](update/ab-tests-doco-for-e2e-tests). 🙏`;
        request.get( {
            headers: { Authorization: 'token ' + process.env.GITHUB_SECRET, 'User-Agent': 'wp-e2e-tests-gh-bridge' },
            url: prURL + '/files'
    } , function ( error, body, response ) {
            if ( error || body.statusCode !== 200 ) {
                console.log( 'Error trying to retrieve files for PR: ' + JSON.stringify( error ) );
                return false;
            }
            const files = JSON.parse(body.body);
            for (let file of files ) {
                if ( file.filename === wpCalysoABTestsFile ) {
                    console.log( 'Found a change to the AB tests file - check if we have already commented on this PR' );

                    request.get( {
                        headers: { Authorization: 'token ' + process.env.GITHUB_SECRET, 'User-Agent': 'wp-e2e-tests-gh-bridge' },
                        url: gitHubIssuessURL + pullRequestNum + "/comments"
                    } , function ( error, body, response ) {
                        if ( error || body.statusCode !== 200 ) {
                            console.log( 'Error trying to retrieve comments for PR: ' + JSON.stringify( error ) );
                            return false;
                        }
                        const comments = JSON.parse(body.body);
                        for (let existingComment of comments ) {
                            if ( existingComment.body === comment ) {
                                console.log( 'Found existing comment about A/B tests - exiting' );
                                return false;
                            }
                        }
                        request.post( {
                            headers: { Authorization: 'token ' + process.env.GITHUB_SECRET, 'User-Agent': 'wp-e2e-tests-gh-bridge' },
                            url: gitHubIssuessURL + pullRequestNum + "/comments",
                            body: JSON.stringify( { "body": comment } )
                        }, function( responseError ) {
                            if ( responseError ) {
                                console.log( 'ERROR: ' + responseError  );
                            } else {
                                console.log( 'GitHub Pull Request changing AB test files commented on' );
                            }
                        } );
                    } );
                    break;
                }
            }
        } );
    }
});
