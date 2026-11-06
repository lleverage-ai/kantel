---
layout: ../layouts/Legal.astro
title: Privacy policy
description: What the hosted Kantel service at app.kantel.dev collects, why, who processes it and how to have it removed.
updated: 6 November 2026
---

Kantel is run by Lleverage B.V. ("Lleverage", "we"). This policy covers kantel.dev and the hosted service at
app.kantel.dev, including its API, CLI sign-in and MCP server. If you self-host Kantel, your control plane and hosts
send nothing to us, and this policy doesn't apply to them: you're responsible for the data they hold.

## What we collect

- **Your account.** Your email address, and your name (and GitHub username) when you sign in with GitHub or Google.
- **What you set up.** Organisations, projects, members and invitations, hosts, sandboxes, snapshots, API keys,
  webhooks and OpenTelemetry endpoints, with their names and settings.
- **Activity.** An audit log of actions in your organisations, and usage figures from your hosts and sandboxes.
- **Technical data.** IP addresses and request details, used to limit sign-in attempts and to keep the service
  running and secure.

Your sandboxes run on your own hosts, so their files, processes and disks stay there. When you open a sandbox's shell,
desktop, browser or ports through the console or the CLI, that traffic is relayed through Kantel to reach you. We
process it only to deliver it.

## Why we use it

We use this data to provide the service: to sign you in, run your organisations, connect your hosts, relay your
sessions and send the webhooks and telemetry you configure. We also use it to keep the service secure, to fix
problems, and to email you about your account. We don't sell it or use it for advertising.

Under the GDPR, our legal basis is the contract with you for running the service, and our legitimate interest in
keeping it secure and working.

## Cookies and analytics

kantel.dev sets no cookies and runs no analytics. The console stores what it needs to keep you signed in and to
remember your settings, such as the theme.

## Who processes it

- **Cloudflare** hosts the service and sends sign-in emails.
- **GitHub and Google** sign you in, only if you choose them.
- **Destinations you configure**, such as webhook and OpenTelemetry endpoints, receive what you send them.

Cloudflare may process data outside the European Economic Area, under the EU's standard contractual clauses.

## How long we keep it

We keep your account and what you set up for as long as you have an account. Audit logs are kept for the retention
period set on your organisation.

You can delete your account yourself, in the console under Settings, then Profile. That deletes your account and your
personal account, with its hosts, environments, webhooks and templates, at once, revokes your API keys and signs you
out everywhere. What you did in an organisation stays in its audit log for its retention period, and sandboxes you kept
private there stay with the organisation.

## Your rights

You can ask to see, correct, export or delete your data, and object to or restrict how we use it. Write to
[legal@lleverage.ai](mailto:legal@lleverage.ai). You can also complain to your data protection authority; in the
Netherlands that's the Autoriteit Persoonsgegevens.

## Changes

We'll update this page, and the date at its top, when we change how we handle data. Significant changes take effect
30 days after they're posted here.
