import * as path from 'path'
import { BrowserCheck, EmailAlertChannel, Frequency } from 'checkly/constructs'

// The email channel Checkly made for the account owner when the account was set up.
// It's referenced by id so the address stays out of this public repository.
const ownerEmail = EmailAlertChannel.fromId(Number(process.env.CHECKLY_ALERT_CHANNEL_ID ?? 498749))

new BrowserCheck('live-builder-github-download', {
  name: 'Live builder: build an alien pfp and download it at 500 px',
  description: 'Opens https://camduncalfe.github.io/agent-pfp/, randomizes an alien, downloads it at GitHub size and checks the PNG is 500 x 500.',
  frequency: Frequency.EVERY_1H,
  locations: ['us-east-1', 'eu-west-1'],
  alertChannels: [ownerEmail],
  tags: ['agent-pfp', 'production'],
  code: {
    entrypoint: path.join(__dirname, 'builder.spec.ts'),
  },
})
