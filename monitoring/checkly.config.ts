import { defineConfig } from 'checkly'

export default defineConfig({
  projectName: 'Agent PFP live builder',
  logicalId: 'agent-pfp-live-builder',
  repoUrl: 'https://github.com/CamDuncalfe/agent-pfp',
  checks: {
    checkMatch: '**/__checks__/*.check.ts',
    ignoreDirectoriesMatch: ['node_modules/**'],
  },
  cli: {
    runLocation: 'eu-west-1',
  },
})
