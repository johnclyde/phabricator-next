FROM alpine:3.22.2@sha256:4b7ce07002c69e8f3d704a9c5d6fd3053be500b7f1c69fc0d80990c2ad8dd412
RUN apk add --no-cache qpdf=12.2.0-r0
COPY tectonic /usr/local/bin/tectonic
COPY bundle.zip /opt/bundle.zip
COPY compile.sh /opt/compile.sh
COPY fonts.conf /opt/fonts.conf
COPY warm.tex /tmp/warm.tex
ARG BUNDLE_SHA256
LABEL org.phabricator.tex.engine="Tectonic 0.17.0" org.phabricator.tex.policy="tex-container-v1"
LABEL org.phabricator.tex.bundle="${BUNDLE_SHA256}"
RUN test -n "$BUNDLE_SHA256" && echo "$BUNDLE_SHA256  /opt/bundle.zip" | sha256sum -c - && \
    chmod 0555 /usr/local/bin/tectonic /opt/compile.sh && mkdir /opt/cache /opt/fonts /source /work && \
    FONTCONFIG_FILE=/opt/fonts.conf TECTONIC_CACHE_DIR=/opt/cache SOURCE_DATE_EPOCH=946684800 tectonic -X compile --bundle /opt/bundle.zip --only-cached --untrusted /tmp/warm.tex && \
    rm -f /tmp/warm.tex /tmp/warm.pdf && chmod -R a+rX /opt/cache
USER 65534:65534
WORKDIR /source
ENTRYPOINT ["/opt/compile.sh"]
