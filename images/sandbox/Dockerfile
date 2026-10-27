# Harbour container tier: a warm base image the session host starts once per
# escalated command. Its network is the default-deny sandbox network, where
# the vault proxy is the only reachable host.
FROM alpine:3.22
RUN apk add --no-cache bash git curl coreutils findutils grep sed jq python3 \
	&& addgroup -g 1000 sandbox \
	&& adduser -D -u 1000 -G sandbox -h /workspace sandbox
USER 1000:1000
WORKDIR /workspace
CMD ["sh"]
