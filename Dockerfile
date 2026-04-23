FROM nginxinc/nginx-unprivileged:stable-alpine

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --chown=101:101 --chmod=644 web/ /usr/share/nginx/html/

EXPOSE 8000
