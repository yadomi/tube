#! /bin/sh
docker run -it --rm --user $(id -u):$(id -g) -w /app --network=host --name tube -v $PWD:/app yadomi/tube sh
