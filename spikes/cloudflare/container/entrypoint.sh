#!/bin/sh
# The egress CA is installed by server.ts before each command until it appears: it exists only after the Durable Object
# turns on HTTPS interception, which happens after this process starts.
exec bun /opt/harbour/server.ts
