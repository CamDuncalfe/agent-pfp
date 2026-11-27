# Monitoring

A Checkly browser check watches the live builder at https://camduncalfe.github.io/agent-pfp/. That GitHub Pages site is production.

Once an hour, from `us-east-1` or `eu-west-1` in turn, the check in [`__checks__/builder.spec.ts`](__checks__/builder.spec.ts) does what a visitor does:

1. Opens the site and follows it to the builder, which opens the alien style.
2. Reads the preview canvas and checks that all 1024 x 1024 pixels are covered by the layers.
3. Clicks Randomize until a trait changes, up to 5 times.
4. Picks GitHub (500 x 500), clicks Download and checks the file is `agent-pfp-alien-500.png`, a PNG 500 px wide and high and over 50 KB.

A failed run, after Checkly's one retry, sends an email to the account owner. [`__checks__/builder.check.ts`](__checks__/builder.check.ts) points at that email channel by id, so the address isn't in this repository.

The check needs no account and saves nothing on the site.

## Run it

This folder has its own `package.json`, so the Checkly CLI never lands in the app's dependencies. You need a Checkly API key and account id.

```sh
cd monitoring
npm ci
CHECKLY_API_KEY=... CHECKLY_ACCOUNT_ID=... npx checkly test     # one run in Checkly's cloud, nothing scheduled
CHECKLY_API_KEY=... CHECKLY_ACCOUNT_ID=... npx checkly deploy   # puts the hourly check live
```
