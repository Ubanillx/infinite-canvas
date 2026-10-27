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
        stage('Test') {
            steps {
                sh 'docker build --target test --tag "infinite-canvas-test:$BUILD_NUMBER-$RELEASE_SHA" .'
            }
        }
        stage('Build image') {
            steps {
                sh '''#!/usr/bin/env bash
                    set -Eeuo pipefail
                    docker build --target runtime --label "org.opencontainers.image.revision=$RELEASE_SHA" --tag "$APP_IMAGE" .
                    mkdir -p .ci
                    docker image inspect --format '{{.Id}}' "$APP_IMAGE" > .ci/image-id
                    docker save "$APP_IMAGE" | gzip > .ci/image.tar.gz
                    cp docker-compose.yml .ci/compose.yml
                    cp deploy/remote-deploy.sh .ci/remote-deploy.sh
                    printf '%s\n' "$APP_IMAGE" > .ci/image-ref
                    printf '%s\n' "$RELEASE_SHA" > .ci/revision
                    (cd .ci && sha256sum image.tar.gz compose.yml remote-deploy.sh image-ref image-id revision > SHA256SUMS)
                    tar -C .ci -czf .ci/release.tar.gz image.tar.gz compose.yml remote-deploy.sh image-ref image-id revision SHA256SUMS
                '''
                script { env.PACKAGE_READY = 'true' }
            }
        }
        stage('Container smoke test') {
            steps {
                // 用隔离的 PostgreSQL + RustFS 跑一次完整启动与健康检查，
                // 结束后删除容器和临时卷，不影响宿主机上已有的中间件。
                sh 'bash deploy/smoke-test.sh'
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
            script {
                if (env.PACKAGE_READY == 'true') {
                    archiveArtifacts artifacts: '.ci/revision,.ci/image-ref,.ci/image-id,.ci/SHA256SUMS', allowEmptyArchive: true
                }
            }
            sh 'rm -f .ci/image.tar.gz .ci/release.tar.gz'
            // 冒烟阶段异常中断时兜底清理隔离栈，避免残留容器占用端口和磁盘。
            sh 'docker compose -p infinite-canvas-smoke -f docker-compose.smoke.yml down -v --remove-orphans >/dev/null 2>&1 || true'
        }
    }
}
