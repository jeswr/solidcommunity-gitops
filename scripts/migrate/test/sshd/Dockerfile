# Read-only SSH source for test.sh: sshd + rsync, key login only. Test use only.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server rsync \
 && rm -rf /var/lib/apt/lists/* && mkdir /run/sshd \
 && useradd -m -s /bin/sh reader && mkdir -p /home/reader/.ssh
COPY authorized_keys /home/reader/.ssh/authorized_keys
RUN chown -R reader /home/reader/.ssh && chmod 600 /home/reader/.ssh/authorized_keys
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e", "-o", "PasswordAuthentication=no"]
