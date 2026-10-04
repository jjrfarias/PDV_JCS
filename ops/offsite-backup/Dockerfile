FROM postgres:18-alpine
RUN apk add --no-cache age aws-cli
COPY backup.sh /backup.sh
RUN chmod 0555 /backup.sh
ENTRYPOINT ["/backup.sh"]
