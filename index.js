const http = require( 'http' );
const request = require( 'request-promise' );
const createHandler = require( 'github-webhook-handler' );
const { logger } = require( '@automattic/vip-go' );

const calypsoProject = process.env.CALYPSO_PROJECT || 'Automattic/wp-calypso';
const jetpackProject = process.env.JETPACK_PROJECT || 'Automattic/jetpack';
const e2eTestsMainProject = process.env.E2E_MAIN_PROJECT || 'Automattic/wp-calypso';
const e2eFullTestsWrapperProject = process.env.E2E_WRAPPER_PROJECT || 'Automattic/wp-e2e-tests-for-branches';
const e2eCanaryTestsWrapperProject = process.env.E2E_WRAPPER_PROJECT || 'Automattic/wp-e2e-canary-for-branches';
const e2eFullTestsWrapperBranch = process.env.E2E_WRAPPER_BRANCH || 'master';
const e2eCanaryTestsWrapperBranch = process.env.E2E_WRAPPER_BRANCH || 'master';

const calypsoCanaryTriggerLabel = process.env.CALYPSO_TRIGGER_LABEL || '[Status] Needs Review';
const calypsoFullSuiteJetpackTriggerLabel = process.env.CALYPSO_FULL_SUITE_JETPACK_TRIGGER_LABEL || '[Status] Needs Jetpack e2e Testing';
const calypsoFullSuiteSecureAuthTriggerLabel = process.env.CALYPSO_FULL_SUITE_SECURE_AUTH_TRIGGER_LABEL || '[Status] Needs Secure Auth e2e Testing';
const calypsoReadyToMergeLabel = process.env.CALYPSO_TRIGGER_LABEL || '[Status] Ready to Merge';

const jetpackCanaryTriggerLabel = process.env.JETPACK_CANARY_TRIGGER_LABEL || '[Status] Needs e2e Canary Testing';

const triggerFullBuildURL = `https://circleci.com/api/v2/project/github/${ e2eFullTestsWrapperProject }/pipeline?circle-token=${ process.env.CIRCLECI_SECRET}`;
const triggerCanaryBuildURL = `https://circleci.com/api/v1.1/project/github/${ e2eCanaryTestsWrapperProject }/tree/${ e2eCanaryTestsWrapperBranch }?circle-token=${ process.env.CIRCLECI_SECRET}`;
const gitHubCalypsoStatusURL = `https://api.github.com/repos/${ calypsoProject }/statuses/`;
const gitHubJetpackStatusURL = `https://api.github.com/repos/${ jetpackProject }/statuses/`;
const gitHubE2EStatusURL = `https://api.github.com/repos/${ e2eTestsMainProject }/statuses/`;
const gitHubMainE2EBranchURL = `https://api.github.com/repos/${ e2eTestsMainProject }/branches/`;
const gitHubCalypsoBranchURL = `https://api.github.com/repos/${ calypsoProject }/branches/`;
const gitHubCalypsoIssueURL = `https://api.github.com/repos/${ calypsoProject }/issues/`;
const circleCIGetWorkflowURL = 'https://circleci.com/api/v2/pipeline/';
const circleCIWorkflowURL = 'https://circleci.com/workflow-run/';
const gitHubWebHookPath = '/ghwebhook';
const circleCIWebHookPath = '/circleciwebhook';
const healthCheckPath = '/cache-healthcheck';

const handler = createHandler( { path: gitHubWebHookPath, secret: process.env.BRIDGE_SECRET } );
const log = logger( 'wp-e2e-tests-gh-bridge:webhook' );

function sleep( ms ) {
	return new Promise( resolve=>{
		setTimeout( resolve, ms )
	} )
}

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
					log.info( `CircleCI build ${payload.build_parameters.build_num} returned status ${payload.outcome} on branch ${payload.build_parameters.branch} for ${payload.build_parameters.prContext}` );
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
							log.error( `ERROR: Error updating GitHub status for CircleCI ${payload.build_parameters.build_num} on branch ${payload.build_parameters.branch} for ${payload.build_parameters.prContext}: ${error}` );
						}
						log.info( `GitHub status updated for CircleCI ${payload.build_parameters.build_num} on branch ${payload.build_parameters.branch} for ${payload.build_parameters.prContext}` );
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

function executeCircleCIBuild( liveBranches, branchArg, branchName, e2eBranchName, pullRequestNum, prContext, testFlag, description, sha, isCanary, calypsoProjectSpecified, jetpackProjectSpecified, envVars = null, calypsoSha = null ) {
	const branchSha = calypsoSha === null ? sha : calypsoSha;
	const runBranch = branchName === null ? e2eBranchName : branchName;
	const buildParameters = {
		branch: e2eFullTestsWrapperBranch,
		parameters: {
			LIVEBRANCHES: liveBranches,
			BRANCHNAME: runBranch,
			E2E_BRANCH: e2eBranchName,
			RUN_ARGS: branchArg + ' ' + branchSha,
			sha: sha,
			pullRequestNum: pullRequestNum.toString(),
			calypsoProject: calypsoProjectSpecified,
			jetpackProject: jetpackProjectSpecified,
			prContext: prContext,
			testFlag: testFlag,
			calypsoSha: branchSha
		}
	};

	if ( envVars ) {
		Object.assign( buildParameters.parameters, envVars )
	}

	const triggerBuildURL = isCanary ? triggerCanaryBuildURL : triggerFullBuildURL;

	// POST to CircleCI to initiate the build
	request.post( {
		headers: {'content-type': 'application/json', accept: 'application/json'},
		url: triggerBuildURL,
		body: JSON.stringify( buildParameters, ( key, value ) => {
			if ( value !== null ) return value
		} )
	}, async function( error, response ) {
		if ( response.statusCode === 201 ) {
			let statusURL;
			let workflowID;
			let getWorkflowURL = circleCIGetWorkflowURL + JSON.parse( response.body ).id + `/workflow?circle-token=${ process.env.CIRCLECI_SECRET}`;
			let workflowFound = false;
			let i = 0;
			log.info( `Tests have been kicked off on branch ${runBranch} for ${prContext} - updating PR status now` );

			// Get workflow ID and update GH when we have one
			while ( i < 60 && !workflowFound ) {
				await sleep( 1000 );
				await request.get( {
					headers: {'content-type': 'application/json', accept: 'application/json'},
					url: getWorkflowURL,
				}, async function( responseError, responseCI ) {
					if ( responseError ) {
						log.error( 'Error when getting workflow ID' );
						log.error( 'ERROR: ' + responseError );
					}
					//Make sure a workflow id was returned
					let workflows = JSON.parse( responseCI.body ).items;
					if ( workflows.length === 0 ) {
						return;
					}
					workflowID = workflows[0].id;
					workflowFound = true;
					// Post status to Github
					const gitHubStatus = {
						state: 'pending',
						target_url: circleCIWorkflowURL + workflowID,
						context: prContext,
						description: description
					};

					if ( calypsoProjectSpecified === calypsoProject ) {
						statusURL = gitHubCalypsoStatusURL;
					} else if ( jetpackProjectSpecified === jetpackProject ) {
						statusURL = gitHubJetpackStatusURL;
					} else if ( calypsoProjectSpecified === e2eTestsMainProject ) {
						statusURL = gitHubE2EStatusURL;
					}
					await request.post( {
						headers: {
							Authorization: 'token ' + process.env.GITHUB_SECRET,
							'User-Agent': 'wp-e2e-tests-gh-bridge'
						},
						url: statusURL + sha,
						body: JSON.stringify( gitHubStatus )
					}, function( responseErrorGH ) {
						if ( responseErrorGH ) {
							log.error( 'ERROR: ' + responseErrorGH );
						}
						log.info( `GitHub status updated on branch ${runBranch} for ${prContext}` );
					} );
				} );
				i++;
			}
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

	if ( event.payload.action === 'synchronize' || event.payload.action === 'opened' ) {
		let mappedLabels = labels.map( l => l.name );
		labelsArray = labelsArray.concat( mappedLabels );
	}

	if ( label !== null ) {
		labelsArray.push( label );
	}

	// Calypso test execution on label

	if ( ( action === 'labeled' || action === 'synchronize' ) &&
		repositoryName === calypsoProject &&
		labelsArray.includes( calypsoFullSuiteJetpackTriggerLabel )
	) {
		const branchName = event.payload.pull_request.head.ref;
		const sha = event.payload.pull_request.head.sha;
		let e2eBranchName, description;

		// Check if there's a matching branch in the main e2e test repository
		request.get( {
			headers: { Authorization: 'token ' + process.env.GITHUB_SECRET, 'User-Agent': 'wp-e2e-tests-gh-bridge' },
			url: gitHubMainE2EBranchURL + branchName,
		}, function( err, response ) {
			e2eBranchName = 'trunk';
			if ( response.statusCode === 200 ) {
				e2eBranchName = branchName;
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
				e2eBranchName = 'trunk';
			}
			if ( labelsArray.includes( jetpackCanaryTriggerLabel ) ) {
				description = 'The e2e canary tests are running against your PR';
				log.info( 'Executing JETPACK e2e canary tests for branch: \'' + branchName + '\'' );
				executeCircleCIBuild( 'false', '-B', branchName, e2eBranchName, pullRequestNum, 'ci/jetpack-e2e-tests-canary', '-p -J', description, sha, true, null, jetpackProject );
			}
		} );
	} else if ( ( action === 'opened' || action === 'synchronize' || action === 'labeled' ) && repositoryName === e2eTestsMainProject ) {
		//Run all e2e tests on wp-e2e-tests PRs
		let branchName = null;
		let branchArg = null;
		let jetpackBranchArg = null;
		let calypsoSha = null;
		let liveBranches = 'false';
		const e2eBranchName = event.payload.pull_request.head.ref;
		const sha = event.payload.pull_request.head.sha;
		let description;

		// Check if there's a matching branch in the main e2e test repository
		request.get( {
			headers: { Authorization: 'token ' + process.env.GITHUB_SECRET, 'User-Agent': 'wp-e2e-tests-gh-bridge' },
			url: gitHubCalypsoBranchURL + e2eBranchName,
		}, function( err, response, body ) {
			if ( response.statusCode === 200 ) {
				branchName = e2eBranchName;
				branchArg = '-S';
				jetpackBranchArg = '-B';
				liveBranches = 'true';
				calypsoSha = JSON.parse( body ).commit.sha;
			}

			if ( labelsArray.includes( calypsoFullSuiteJetpackTriggerLabel ) ) {
				// Jetpack full suite
				description = 'The e2e full Jetpack suite tests are running against your PR';
				const envVars = {JETPACKHOST: 'PRESSABLE'};
				log.info( 'Executing CALYPSO e2e full Jetpack suite tests for branch: \'' + e2eBranchName + '\'' );
				executeCircleCIBuild( liveBranches, jetpackBranchArg, branchName, e2eBranchName, pullRequestNum, 'ci/wp-e2e-tests-full-jetpack', '-j -s mobile', description, sha, false, e2eTestsMainProject, null, envVars, calypsoSha );
			}

			if ( labelsArray.includes( calypsoFullSuiteSecureAuthTriggerLabel ) ) {
				// Secure Auth full suite
				description = 'The e2e full Secure Auth suite tests are running against your PR';
				log.info( 'Executing CALYPSO e2e full Secure Auth suite tests for branch: \'' + e2eBranchName + '\'' );
				executeCircleCIBuild( liveBranches, branchArg, branchName, e2eBranchName, pullRequestNum, 'ci/wp-e2e-tests-full-secure-auth', '-F -s desktop, mobile', description, sha, false, e2eTestsMainProject, null, null, calypsoSha );
			}
		} );
	} else if ( event.payload.pull_request.state === 'open' && !labelsArray.includes( calypsoCanaryTriggerLabel ) &&
			!labelsArray.includes( calypsoReadyToMergeLabel ) && action !== 'unlabeled' ) {
		checkIfLabelIsNeededAndAdd( event.payload.pull_request );
	}
} );

handler.on( 'pull_request_review', function( event ) {
	const labels = event.payload.pull_request.labels;
	let labelsArray = labels.map( l => l.name );

	if ( event.payload.pull_request.state === 'open' && !labelsArray.includes( calypsoCanaryTriggerLabel ) &&
		!labelsArray.includes( calypsoReadyToMergeLabel ) ) {
		checkIfLabelIsNeededAndAdd( event.payload.pull_request );
	}
} );

function checkIfLabelIsNeededAndAdd( pullRequest ) {
	if ( pullRequest.requested_reviewers.length > 0 || pullRequest.requested_teams.length > 0 ) {
		return addNeedsReviewLabel( pullRequest.number );
	}

	request.get( {
		headers: { Authorization: 'token ' + process.env.GITHUB_SECRET, 'User-Agent': 'wp-e2e-tests-gh-bridge', Accept: 'application/vnd.github.starfox-preview+json' },
		url: gitHubCalypsoIssueURL + pullRequest.number + '/events',
	}, function( err, response, body ) {
		body = JSON.parse( body );

		if ( response.statusCode === 200 ) {
			for ( let i = 0; i < body.length; i++ ) {
				if ( body[i].event === 'moved_columns_in_project' && ( body[i].project_card.column_name.toString().toLowerCase().includes( 'needs review' ) || body[i].project_card.column_name.toString().toLowerCase().includes( 'ready for review' ) ) ) {
					return addNeedsReviewLabel( pullRequest.number );
				}
			}
		}
	} );
}

function addNeedsReviewLabel( prNumber ) {
	const gitHubLabel = {
		labels: [calypsoCanaryTriggerLabel]
	};
	log.info( 'Adding Needs Review label to PR #' + prNumber );
	request.post( {
		headers: {
			Authorization: 'token ' + process.env.GITHUB_SECRET,
			'User-Agent': 'wp-e2e-tests-gh-bridge'
		},
		url: gitHubCalypsoIssueURL + prNumber + '/labels',
		body: JSON.stringify( gitHubLabel )
	} );
}
