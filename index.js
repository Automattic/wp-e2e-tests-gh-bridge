const http = require( 'http' );
const request = require( 'request' );
const createHandler = require( 'github-webhook-handler' );
const { logger } = require( '@automattic/vip-go' );

const calypsoProject = process.env.CALYPSO_PROJECT || 'Automattic/wp-calypso';
const jetpackProject = process.env.JETPACK_PROJECT || 'Automattic/jetpack';
const e2eTestsMainProject = process.env.E2E_MAIN_PROJECT || 'Automattic/wp-e2e-tests';
const e2eFullTestsWrapperProject = process.env.E2E_WRAPPER_PROJECT || 'Automattic/wp-e2e-tests-for-branches';
const e2eCanaryTestsWrapperProject = process.env.E2E_WRAPPER_PROJECT || 'Automattic/wp-e2e-canary-for-branches';
const e2eFullTestsWrapperBranch = process.env.E2E_WRAPPER_BRANCH || 'master';
const e2eCanaryTestsWrapperBranch = process.env.E2E_WRAPPER_BRANCH || 'master';

const calypsoCanaryTriggerLabel = process.env.CALYPSO_TRIGGER_LABEL || '[Status] Needs Review';
const calypsoFullSuiteTriggerLabel = process.env.CALYPSO_FULL_SUITE_TRIGGER_LABEL || '[Status] Needs e2e Testing';
const calypsoFullSuiteJetpackTriggerLabel = process.env.CALYPSO_FULL_SUITE_JETPACK_TRIGGER_LABEL || '[Status] Needs Jetpack e2e Testing';

const jetpackCanaryTriggerLabel = process.env.JETPACK_CANARY_TRIGGER_LABEL || '[Status] Needs e2e Canary Testing';

const triggerFullBuildURL = `https://circleci.com/api/v1.1/project/github/${ e2eFullTestsWrapperProject }/tree/${ e2eFullTestsWrapperBranch }?circle-token=${ process.env.CIRCLECI_SECRET}`;
const triggerCanaryBuildURL = `https://circleci.com/api/v1.1/project/github/${ e2eCanaryTestsWrapperProject }/tree/${ e2eCanaryTestsWrapperBranch }?circle-token=${ process.env.CIRCLECI_SECRET}`;
const gitHubCalypsoStatusURL = `https://api.github.com/repos/${ calypsoProject }/statuses/`;
const gitHubJetpackStatusURL = `https://api.github.com/repos/${ jetpackProject }/statuses/`;
const gitHubE2EStatusURL = `https://api.github.com/repos/${ e2eTestsMainProject }/statuses/`;
const gitHubCalypsoIssuesURL = `https://api.github.com/repos/${ calypsoProject }/issues/`;
const gitHubMainE2EBranchURL = `https://api.github.com/repos/${ e2eTestsMainProject }/branches/`;
const wpCalypsoABTestsFile = 'client/lib/abtest/active-tests.js';

const gitHubWebHookPath = '/ghwebhook';
const circleCIWebHookPath = '/circleciwebhook';
const healthCheckPath = '/cache-healthcheck';

const handler = createHandler( { path: gitHubWebHookPath, secret: process.env.BRIDGE_SECRET } );
const log = logger( 'wp-e2e-tests-gh-bridge:webhook' );

http.createServer( function( req, res ) {
	const fullUrl = req.url;
	const path = fullUrl.split( '?' )[0];
	if ( path === gitHubWebHookPath ) {
		handler( req, res, function( err ) {
			res.statusCode = 404;
			res.end( 'invalid location' + err );
		} );
	} else if ( path === healthCheckPath ) {
		res.statusCode = 200;
		res.end( 'OK' );
	} else if ( path === circleCIWebHookPath ) {
		log.debug( 'Called from CircleCI' );
		let body = [];
		req.on( 'data', function( chunk ) {
			body.push( chunk );
		} ).on( 'end', function() {
			body = Buffer.concat( body ).toString();
			try {
				let payload = JSON.parse( body ).payload;
				let statusURL;
				if ( payload && payload.build_parameters && payload.build_parameters.calypsoProject === calypsoProject ) {
					statusURL = gitHubCalypsoStatusURL;
				} else if ( payload && payload.build_parameters && payload.build_parameters.jetpackProject === jetpackProject ) {
					statusURL = gitHubJetpackStatusURL;
				} else if ( payload && payload.build_parameters && payload.build_parameters.calypsoProject === e2eTestsMainProject ) {
					statusURL = gitHubE2EStatusURL;
				} else {
					log.info( 'Unknown project called from CircleCI' );
				}
				if ( statusURL && payload && payload.build_parameters && payload.build_parameters.sha ) {
					let status, desc;
					if ( payload.outcome === 'success' ) {
						status = 'success';
						desc = 'Your PR passed the e2e tests on CircleCI!';
					} else if ( payload.outcome === 'failed' ) {
						status = 'failure';
						desc = `e2e test status: ${payload.status}`;
					} else {
						status = 'error';
						desc = `e2e test status: ${payload.status}`;
					}
					// POST to GitHub to provide status
					let gitHubStatus = {
						state: status,
						description: desc,
						target_url: payload.build_url,
						context: payload.build_parameters.prContext
					};
					request.post( {
						headers: { Authorization: 'token ' + process.env.GITHUB_SECRET, 'User-Agent': 'wp-e2e-tests-gh-bridge' },
						url: statusURL + payload.build_parameters.sha,
						body: JSON.stringify( gitHubStatus )
					}, function( error ) {
						if ( error ) {
							log.error( `ERROR: ${error}` );
						}
						log.debug( 'GitHub status updated' );
					} );
				}
			} catch ( e ) {
				log.info( 'Non-CircleCI packet received' );
			}
			res.statusCode = 200;
			res.end( 'ok' );
		} );
	} else {
		log.error( 'unknown location', fullUrl );
		res.statusCode = 404;
		res.end( 'no such location' );
	}
} ).listen( process.env.PORT || 7777 );

handler.on( 'error', function( err ) {
	log.error( 'Error: %s', err.message );
} );

function executeCircleCIBuild( liveBranches, branchArg, branchName, e2eBranchName, pullRequestNum, prContext, testFlag, description, sha, isCanary, calypsoProjectSpecified, jetpackProjectSpecified, envVars = null ) {
	const buildParameters = {
		build_parameters: {
			LIVEBRANCHES: liveBranches,
			BRANCHNAME: branchName,
			E2E_BRANCH: e2eBranchName,
			RUN_ARGS: branchArg + ' ' + sha,
			sha: sha,
			pullRequestNum: pullRequestNum,
			calypsoProject: calypsoProjectSpecified,
			jetpackProject: jetpackProjectSpecified,
			prContext: prContext,
			testFlag: testFlag
		}
	};

	if ( envVars ) {
		Object.assign( buildParameters.build_parameters, envVars )
	}

	const triggerBuildURL = isCanary ? triggerCanaryBuildURL : triggerFullBuildURL;

	// POST to CircleCI to initiate the build
	request.post( {
		headers: {'content-type': 'application/json', accept: 'application/json'},
		url: triggerBuildURL,
		body: JSON.stringify( buildParameters )
	}, function( error, response ) {
		if ( response.statusCode === 201 ) {
			let statusURL;
			log.debug( 'Tests have been kicked off - updating PR status now' );
			// Post status to Github
			const gitHubStatus = {
				state: 'pending',
				target_url: JSON.parse( response.body ).build_url,
				context: prContext,
				description: description
			};

			if ( calypsoProjectSpecified === calypsoProject ) {
				statusURL = gitHubCalypsoStatusURL;
			} else if ( jetpackProjectSpecified === jetpackProject ) {
				statusURL = gitHubJetpackStatusURL;
			} else if ( calypsoProjectSpecified === e2eTestsMainProject ) {
				statusURL = gitHubE2EStatusURL;
			} else {
				log.info( 'Unknown project called from CircleCI' );
			}
			request.post( {
				headers: { Authorization: 'token ' + process.env.GITHUB_SECRET, 'User-Agent': 'wp-e2e-tests-gh-bridge' },
				url: statusURL + sha,
				body: JSON.stringify( gitHubStatus )
			}, function( responseError ) {
				if ( responseError ) {
					log.error( 'ERROR: ' + responseError );
				}
				log.debug( 'GitHub status updated' );
			} );
		} else {
			// Something went wrong - TODO: post message to the Pull Request about
			log.error( 'Something went wrong with executing e2e tests' );
			log.error( 'ERROR::' + error + 'RESPONSE::' + JSON.stringify( response ) );
		}
	} );
}

handler.on( 'pull_request', function( event ) {
	const pullRequestNum = event.payload.pull_request.number;
	const pullRequestStatus = event.payload.pull_request.state;
	const pullRequestHeadLabel = event.payload.pull_request.head.label;
	const repositoryName = event.payload.repository.full_name;
	const action = event.payload.action;
	const prURL = event.payload.pull_request.url;
	const label = event.payload.label ? event.payload.label.name : null;
	const labels = event.payload.pull_request.labels;
	let labelsArray = [];

	// Make sure the PR is in the correct repositories
	if ( repositoryName !== calypsoProject && repositoryName !== jetpackProject && repositoryName !== e2eTestsMainProject ) {
		log.info( `Ignoring pull request '${ pullRequestNum }' as the repository '${ repositoryName }' is not '${ calypsoProject }' or '${ jetpackProject }'` );
		return true;
	}

	// Make sure the PR is still open
	if ( pullRequestStatus !== 'open' ) {
		log.info( `Ignoring pull request '${ pullRequestNum }' as the status '${ pullRequestStatus }' is not 'open'` );
		return true;
	}

	// Ignore OSS requests - check for location of head to indicate forks
	if ( event.payload.pull_request.head.label.indexOf( 'Automattic:' ) !== 0 ) {
		log.info( `Ignoring pull request '${ pullRequestNum }' as this is from a fork: '${ pullRequestHeadLabel }'` );
		return true;
	}

	if ( event.payload.action === 'synchronize' ) {
		let mappedLabels = labels.map( l => l.name );
		labelsArray = labelsArray.concat( mappedLabels );
	}

	if ( label !== null ) {
		labelsArray.push( label );
	}

	// Calypso test execution on label
	if ( ( action === 'labeled' || action === 'synchronize' ) && repositoryName === calypsoProject && ( labelsArray.includes( calypsoCanaryTriggerLabel ) || labelsArray.includes( calypsoFullSuiteTriggerLabel ) || labelsArray.includes( calypsoFullSuiteJetpackTriggerLabel ) ) ) {
		const branchName = event.payload.pull_request.head.ref;
		const sha = event.payload.pull_request.head.sha;
		let e2eBranchName, description;

		// Check if there's a matching branch in the main e2e test repository
		request.get( {
			headers: { Authorization: 'token ' + process.env.GITHUB_SECRET, 'User-Agent': 'wp-e2e-tests-gh-bridge' },
			url: gitHubMainE2EBranchURL + branchName,
		}, function( err, response ) {
			e2eBranchName = 'master';
			if ( response.statusCode === 200 ) {
				e2eBranchName = branchName;
			}

			if ( labelsArray.includes( calypsoCanaryTriggerLabel ) ) {
				// Canary Tests
				description = 'The e2e canary tests are running against your PR';
				log.info( 'Executing CALYPSO e2e canary tests for branch: \'' + branchName + '\'' );
				executeCircleCIBuild( 'true', '-S', branchName, e2eBranchName, pullRequestNum, 'ci/wp-e2e-tests-canary', '-C', description, sha, true, calypsoProject );
				// IE11 Canary Tests
				description = 'The IE11 e2e canary tests are running against your PR';
				log.info( 'Executing CALYPSO e2e canary IE11 tests for branch: \'' + branchName + '\'' );
				executeCircleCIBuild( 'true', '-S', branchName, e2eBranchName, pullRequestNum, 'ci/wp-e2e-tests-canary-ie11', '-z', description, sha, true, calypsoProject );
				// Safari v10 Canary Tests
				description = 'The Safari v10 e2e canary tests are running against your PR';
				log.info( 'Executing CALYPSO e2e canary Safari v10 tests for branch: \'' + branchName + '\'' );
				executeCircleCIBuild( 'true', '-S', branchName, e2eBranchName, pullRequestNum, 'ci/wp-e2e-tests-canary-safari10', '-y', description, sha, true, calypsoProject );
			}
			if ( labelsArray.includes( calypsoFullSuiteTriggerLabel ) ) {
				description = 'The e2e full WPCOM suite tests are running against your PR';
				log.info( 'Executing CALYPSO e2e full WPCOM suite tests for branch: \'' + branchName + '\'' );
				executeCircleCIBuild( 'true', '-S', branchName, e2eBranchName, pullRequestNum, 'ci/wp-e2e-tests-full', '-p -g', description, sha, false, calypsoProject );
			}
			if ( labelsArray.includes( calypsoFullSuiteJetpackTriggerLabel ) ) {
				description = 'The e2e full Jetpack suite tests are running against your PR';
				const envVars = { JETPACKHOST: 'PRESSABLEBLEEDINGEDGE' };
				log.info( 'Executing CALYPSO e2e full Jetpack suite tests for branch: \'' + branchName + '\'' );
				executeCircleCIBuild( 'true', '-S', branchName, e2eBranchName, pullRequestNum, 'ci/wp-e2e-tests-full-jetpack', '-j -s mobile', description, sha, false, calypsoProject, null, envVars );
			}
		} );
	} else if ( ( action === 'labeled' || action === 'synchronize' ) && repositoryName === jetpackProject && labelsArray.includes( jetpackCanaryTriggerLabel ) ) { // Jetpack test execution on label
		const branchName = event.payload.pull_request.head.ref;
		const sha = event.payload.pull_request.head.sha;
		let e2eBranchName, description;

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
			if ( labelsArray.includes( jetpackCanaryTriggerLabel ) ) {
				description = 'The e2e canary tests are running against your PR';
				log.info( 'Executing JETPACK e2e canary tests for branch: \'' + branchName + '\'' );
				executeCircleCIBuild( 'false', '-B', branchName, e2eBranchName, pullRequestNum, 'ci/jetpack-e2e-tests-canary', '-p -J', description, sha, true, null, jetpackProject );
			}
		} );
	} else if ( action === 'opened' && repositoryName === e2eTestsMainProject ) {
		//Run all e2e tests on wp-e2e-tests PRs
		const branchName = event.payload.pull_request.head.ref;
		const sha = event.payload.pull_request.head.sha;
		let description;

		// Canary Tests
		description = 'The e2e canary tests are running against your PR';
		log.info( 'Executing CALYPSO e2e canary tests for branch: \'' + branchName + '\'' );
		executeCircleCIBuild( 'false', null, null, branchName, pullRequestNum, 'ci/wp-e2e-tests-canary', '-C', description, sha, true, e2eTestsMainProject );
		// IE11 Canary Tests
		description = 'The IE11 e2e canary tests are running against your PR';
		log.info( 'Executing CALYPSO e2e canary IE11 tests for branch: \'' + branchName + '\'' );
		executeCircleCIBuild( 'false', null, null, branchName, pullRequestNum, 'ci/wp-e2e-tests-canary-ie11', '-z', description, sha, true, e2eTestsMainProject );
		// Safari v10 Canary Tests
		description = 'The Safari v10 e2e canary tests are running against your PR';
		log.info( 'Executing CALYPSO e2e canary Safari v10 tests for branch: \'' + branchName + '\'' );
		executeCircleCIBuild( 'false', null, null, branchName, pullRequestNum, 'ci/wp-e2e-tests-canary-safari10', '-y', description, sha, true, e2eTestsMainProject );
		// Jetpack full suite
		description = 'The e2e full Jetpack suite tests are running against your PR';
		const envVars = {JETPACKHOST: 'PRESSABLEBLEEDINGEDGE'};
		log.info( 'Executing CALYPSO e2e full Jetpack suite tests for branch: \'' + branchName + '\'' );
		executeCircleCIBuild( 'false', null, null, branchName, pullRequestNum, 'ci/wp-e2e-tests-full-jetpack', '-j -s mobile', description, sha, false, e2eTestsMainProject, null, envVars );
		// WooCommerce full suite
		description = 'The e2e full WooCommerce suite tests are running against your PR';
		log.info( 'Executing CALYPSO e2e full WooCommerce suite tests for branch: \'' + branchName + '\'' );
		executeCircleCIBuild( 'false', null, null, branchName, pullRequestNum, 'ci/wp-e2e-tests-full-woocommerce', '-W', description, sha, false, e2eTestsMainProject );
	} else if ( repositoryName === calypsoProject && ( action === 'synchronize' || action === 'opened' ) ) { // Comment about A/B tests for Calypso
		const comment = `It looks like you're updating \`client/lib/abtest/active-tests.js\`. Can you please ensure our [automated e2e tests](https://github.com/${ e2eTestsMainProject }) know about this change? Instructions on how to do this are available [here](https://github.com/${ calypsoProject }/tree/master/client/lib/abtest#updating-our-end-to-end-tests-to-avoid-inconsistencies-with-ab-tests). 🙏`;
		request.get( {
			headers: { Authorization: 'token ' + process.env.GITHUB_SECRET, 'User-Agent': 'wp-e2e-tests-gh-bridge' },
			url: prURL + '/files'
		}, function( error, body ) {
			if ( error || body.statusCode !== 200 ) {
				log.error( 'Error trying to retrieve files for PR: ' + JSON.stringify( error ) );
				return false;
			}
			const files = JSON.parse( body.body );
			for ( let file of files ) {
				if ( file.filename === wpCalypsoABTestsFile ) {
					log.info( 'Found a change to the AB tests file - check if we have already commented on this PR' );

					request.get( {
						headers: { Authorization: 'token ' + process.env.GITHUB_SECRET, 'User-Agent': 'wp-e2e-tests-gh-bridge' },
						url: gitHubCalypsoIssuesURL + pullRequestNum + '/comments'
					}, function( err, body ) {
						if ( err || body.statusCode !== 200 ) {
							log.error( 'Error trying to retrieve comments for PR: ' + JSON.stringify( error ) );
							return false;
						}
						const comments = JSON.parse( body.body );
						for ( let existingComment of comments ) {
							if ( existingComment.body === comment ) {
								log.info( 'Found existing comment about A/B tests - exiting' );
								return false;
							}
						}
						request.post( {
							headers: { Authorization: 'token ' + process.env.GITHUB_SECRET, 'User-Agent': 'wp-e2e-tests-gh-bridge' },
							url: gitHubCalypsoIssuesURL + pullRequestNum + '/comments',
							body: JSON.stringify( { body: comment } )
						}, function( responseError ) {
							if ( responseError ) {
								log.error( 'ERROR: ' + responseError );
							} else {
								log.info( 'GitHub Pull Request changing AB test files commented on' );
							}
						} );
					} );
					break;
				}
			}
		} );
	}
} );
