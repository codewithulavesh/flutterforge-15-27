FROM ubuntu:24.04
ARG FLUTTER_REF=ab2912035e160d9cad6306df307576da6128ebdb
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git unzip xz-utils libglu1-mesa libgtk-3-0 libstdc++6 && rm -rf /var/lib/apt/lists/*
RUN git init /opt/flutter && cd /opt/flutter && git remote add origin https://github.com/flutter/flutter.git && git fetch --depth 1 origin "$FLUTTER_REF" && git checkout --detach FETCH_HEAD
ENV PATH=/opt/flutter/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
RUN flutter config --no-analytics && flutter precache --web --linux
RUN test "$(git -C /opt/flutter rev-parse HEAD)" = "$FLUTTER_REF" && git -C /opt/flutter tag 3.50.0 && rm -f /opt/flutter/bin/cache/flutter.version.json
COPY entrypoint.sh /usr/local/bin/engine-entrypoint
RUN chmod 755 /usr/local/bin/engine-entrypoint && find /opt/flutter -type f ! -perm -004 -exec chmod a+r {} +
WORKDIR /workspace
USER 1000:1000
ENTRYPOINT ["/usr/local/bin/engine-entrypoint"]
CMD ["flutter", "--version"]
