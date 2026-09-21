FROM debian:13-slim

LABEL org.opencontainers.image.title="LumaDesk OS" \
      org.opencontainers.image.description="Browser-based Debian workspace with systemd and Railway compatibility modes" \
      org.opencontainers.image.source="https://github.com/QWERTY-enter/lumadesk-webos" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="1.1.0"

ARG DEBIAN_FRONTEND=noninteractive
ENV container=docker \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PYTHONUNBUFFERED=1 \
    WEBOS_HOME=/home/webos \
    WEBOS_STATE=/var/lib/lumadesk \
    WEBOS_USER=webos

RUN apt-get update && apt-get install -y --no-install-recommends \
      systemd systemd-sysv dbus dbus-user-session \
      python3 python3-aiohttp python3-psutil \
      bash bash-completion ca-certificates curl \
      procps psmisc iproute2 iputils-ping net-tools util-linux \
      git nano vim-tiny less cron tzdata locales \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/* \
    && useradd --create-home --uid 1000 --groups systemd-journal --shell /bin/bash webos \
    && mkdir -p /opt/lumadesk /var/lib/lumadesk \
       /home/webos/Desktop /home/webos/Documents /home/webos/Downloads /home/webos/Projects \
    && chown -R webos:webos /home/webos /var/lib/lumadesk

COPY --chown=root:root app/ /opt/lumadesk/
COPY --chown=root:root VERSION /opt/lumadesk/VERSION
COPY --chown=root:root systemd/lumadesk.service /etc/systemd/system/lumadesk.service
COPY --chown=root:root systemd/lumadesk-maintenance.service /etc/systemd/system/lumadesk-maintenance.service
COPY --chown=root:root systemd/lumadesk-maintenance.timer /etc/systemd/system/lumadesk-maintenance.timer
COPY --chown=root:root scripts/maintenance.sh /opt/lumadesk/bin/maintenance.sh
COPY --chown=root:root scripts/healthcheck.sh /opt/lumadesk/bin/healthcheck.sh
COPY --chown=root:root scripts/entrypoint.sh /usr/local/sbin/lumadesk-entrypoint
COPY --chown=webos:webos seed/ /home/webos/

RUN chmod 0755 /opt/lumadesk/server.py /opt/lumadesk/bin/maintenance.sh \
        /opt/lumadesk/bin/healthcheck.sh /usr/local/sbin/lumadesk-entrypoint \
    && systemctl enable lumadesk.service lumadesk-maintenance.timer \
    && systemctl set-default multi-user.target \
    && systemctl mask dev-hugepages.mount sys-fs-fuse-connections.mount systemd-remount-fs.service \
    && rm -f /etc/systemd/system/multi-user.target.wants/getty.target \
    && rm -f /etc/systemd/system/getty.target.wants/getty@tty1.service

EXPOSE 8080
STOPSIGNAL SIGRTMIN+3
HEALTHCHECK --interval=20s --timeout=4s --start-period=25s --retries=4 \
  CMD ["/opt/lumadesk/bin/healthcheck.sh"]

ENTRYPOINT ["/usr/local/sbin/lumadesk-entrypoint"]
CMD ["/sbin/init"]
