pipeline {
    agent { label 'docker-linux' }
    options {
        skipDefaultCheckout(true)
        disableConcurrentBuilds()
    }
    triggers { githubPush() }
    parameters {
        string(name: 'DEPLOY_HOST', defaultValue: params.DEPLOY_HOST ?: '', description: 'SSH hostname or IPv4 address; required; retained for webhook runs')
        string(name: 'DEPLOY_PORT', defaultValue: params.DEPLOY_PORT ?: '22', description: 'SSH port')
        string(name: 'DEPLOY_DIR', defaultValue: params.DEPLOY_DIR ?: '/opt/infinite-canvas', description: 'Pre-created directory owned by the deploy user')
        string(name: 'COMPOSE_PROJECT', defaultValue: params.COMPOSE_PROJECT ?: 'infinite-canvas', description: 'Stable project name; never change after first deployment')
    }
    stages {
        stage('Checkout deploy') {
            steps {
                script {
                    if (env.CHANGE_ID) error('Pull requests cannot build or deploy this job')
                    if (!params.DEPLOY_HOST?.trim()) error('Configure DEPLOY_HOST before running the deployment pipeline')
                    def scmVars = checkout scm
                    def branch = env.BRANCH_NAME ?: scmVars.GIT_BRANCH
                    if (!(branch in ['deploy', 'origin/deploy'])) {
                        error('Only deploy is permitted. Configure SCM branch specifier */deploy.')
                    }
                    env.RELEASE_SHA = sh(returnStdout: true, script: '''
                        set -eu
                        git fetch origin +refs/heads/deploy:refs/remotes/origin/deploy
                        test "$(git rev-parse HEAD)" = "$(git rev-parse origin/deploy)"
                        git rev-parse HEAD
                    ''').trim()
                    env.APP_IMAGE = "infinite-canvas:${env.RELEASE_SHA}-${env.BUILD_NUMBER}"
                }
            }
        }
        stage('Cleanup build node') {
            steps {
                withCredentials([
                    sshUserPrivateKey(credentialsId: 'infinite-canvas-deploy-ssh', keyFileVariable: 'DEPLOY_KEY', usernameVariable: 'DEPLOY_USER'),
                    file(credentialsId: 'infinite-canvas-known-hosts', variable: 'KNOWN_HOSTS')
                ]) {
                    sh 'bash deploy/ssh-deploy.sh --retention'
                }
                sh 'bash deploy/cleanup-docker.sh .ci/retained-images'
            }
        }
        stage('Build image') {
            steps {
                sh '''#!/usr/bin/env bash
                    set -Eeuo pipefail
                    if ! docker buildx version; then
                        printf '%s\n' \
                            'Docker Buildx is missing or broken in this Jenkins agent.' \
                            'Install docker-buildx-plugin in the environment running the Docker CLI, including the Jenkins agent container if used.' \
                            'Verify docker buildx version as the same Jenkins user. See deploy/README.md for package and plugin-path troubleshooting.' >&2
                        exit 1
                    fi
                    command -v rsync >/dev/null || { echo 'Install rsync on the Jenkins build node first' >&2; exit 1; }
                    DOCKER_BUILDKIT=1 docker build --progress=plain --target runtime --label "org.opencontainers.image.revision=$RELEASE_SHA" --tag "$APP_IMAGE" .
                '''
            }
        }
        stage('Package release') {
            steps {
                sh '''#!/usr/bin/env bash
                    set -Eeuo pipefail
                    umask 077
                    mkdir -p .ci
                    docker image inspect --format '{{.Id}}' "$APP_IMAGE" > .ci/image-id
                    docker save "$APP_IMAGE" > .ci/image.tar
                    cp docker-compose.yml .ci/compose.yml
                    cp deploy/remote-deploy.sh .ci/remote-deploy.sh
                    cp deploy/import-codex-config.sh .ci/import-codex-config.sh
                    cp deploy/cleanup-docker.sh .ci/cleanup-docker.sh
                    printf '%s\n' "$APP_IMAGE" > .ci/image-ref
                    printf '%s\n' "$RELEASE_SHA" > .ci/revision
                    (cd .ci && sha256sum image.tar compose.yml remote-deploy.sh import-codex-config.sh cleanup-docker.sh image-ref image-id revision > SHA256SUMS)
                    tar -C .ci -czf .ci/release.tar.gz compose.yml remote-deploy.sh import-codex-config.sh cleanup-docker.sh image-ref image-id revision SHA256SUMS
                '''
                script { env.PACKAGE_READY = 'true' }
            }
        }
        stage('SSH deploy') {
            steps {
                withCredentials([
                    sshUserPrivateKey(credentialsId: 'infinite-canvas-deploy-ssh', keyFileVariable: 'DEPLOY_KEY', usernameVariable: 'DEPLOY_USER'),
                    file(credentialsId: 'infinite-canvas-known-hosts', variable: 'KNOWN_HOSTS')
                ]) {
                    sh 'bash deploy/ssh-deploy.sh'
                }
            }
        }
    }
    post {
        always {
            sh 'rm -f .ci/image.tar .ci/release.tar.gz .ci/infra-images.tar.gz'
            script {
                if (currentBuild.currentResult != 'ABORTED' && env.RELEASE_SHA && fileExists('deploy/cleanup-docker.sh')) {
                    sh 'bash deploy/cleanup-docker.sh .ci/retained-images --build-cache || echo "Warning: build-node Docker cleanup failed" >&2'
                }
                if (env.PACKAGE_READY == 'true') {
                    archiveArtifacts artifacts: '.ci/revision,.ci/image-ref,.ci/image-id,.ci/SHA256SUMS', allowEmptyArchive: true
                }
            }
        }
    }
}
