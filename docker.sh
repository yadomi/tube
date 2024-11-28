docker run -it --rm --user $(id -u):$(id -g) --network=host --name tube -v $PWD:/app yadomi/tube sh
