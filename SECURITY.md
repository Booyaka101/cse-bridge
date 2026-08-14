# Security Policy

## Supported versions

The latest version published to npm is the only one that gets fixes.

## Reporting a vulnerability

Please **don't** open a public issue for a security problem.

Use GitHub's [private vulnerability reporting](https://github.com/Booyaka101/cse-bridge/security/advisories/new) instead. Expect a first response within a week.

Please include what you found, how to reproduce it, and what an attacker gets out of it.

## What this touches

Proxies Custom Search JSON API calls to a replacement backend. Your key passes through it.

- **Your Google API key and CX id pass through it.** They go to the backend you configure, over HTTPS. They are not logged and not written to disk.
- **The backend is configurable.** Whatever you point it at receives your key. Don't point it at a host you don't trust.

## Scope

In scope: anything that leaks a credential, reads data belonging to someone else, or lets untrusted input reach code execution.

Out of scope: findings that require an attacker to already control the machine it runs on.
