# wp-e2e-tests-gh-bridge

A webhooks client that sits between wp-calypso pull requests and e2e canary tests to execute the e2e tests against pull requests and provide status updates.

These webhooks also comment on wp-calypso PRs that modify the active A/B tests file to ensure these are updated in the e2e tests project.

These provide two webhook paths to do this:

1. https://a8c-gh-e2e-bridge.go-vip.co/ghwebhook: this is the GitHub webhook that takes the pull request event and kicks off a corresponding CircleCI e2e canary test build
2. https://a8c-gh-e2e-bridge.go-vip.co/circleciwebhook: this is the CircleCI webhook that takes the circleCI webhook when a build is finished and updates the GithHub wp-calypso PR with the appropriate execution result

## Local development using ngrok (on macOS)

1. Install ngrok - `brew install ngrok` on macOS
2. Set bridge secret `export BRIDGE_SECRET='mysecret'` where `mysecret` is a generated key
3. Set CircleCI key `export CIRCLECI_SECRET='circlesecret'` where `circlesecret` is a [CircleCI API](https://circleci.com/account/api)
4. Set GitHub Key `export GITHUB_SECRET='githubkey'` where `githubkey` is a [GitHub API key](https://github.com/settings/tokens)
5. Optionally set `CALYPSO_PROJECT`, `E2E_MAIN_PROJECT`, `E2E_WRAPPER_PROJECT`, `E2E_WRAPPER_BRANCH`, `TRIGGER_LABEL` and `FLOW_PATROL_ONLY` if you wish to override the default values
6. `npm start` which starts this server on port 7777
7. In another terminal tab, run `ngrok http 7777` which should provide you a HTTPS url to your localhost server: eg. `https://675bbbef.ngrok.io -> localhost:7777`
8. Make sure you can access your webhook: eg. `curl https://675bbbef.ngrok.io/circleciwebhook`
9. Add your ngrok webhook URLs to both Github Project Webhooks (via the UI) and Circle (via `circle.yml`) - when adding the Webhook to GitHub only select the 'Pull Request' event and make sure you choose content type of 'application/json'
10. As you make changes you will need to re-run `npm start` but ngrok will continue to work

## Deployment to VIP GO

These webhooks are now hosted on VIP GO (see links above). Just merge to master and it will be deployed 😊

Bump4
