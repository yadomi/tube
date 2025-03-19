#! /bin/sh
docker run -it --rm -w /app -p=8888:8888 --name tube -v $PWD:/app yadomi/tube sh
