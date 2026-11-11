// Commands an isolate doesn't have. Each answers as a missing command does (127), says what to use, and marks the
// command as one a microVM would run (needsMicrovm), so Kantel can offer the upgrade or make it (autoUpgrade).

/** just-bash lists these but its browser bundle can't run them (tar, yq, xan, sqlite3) or they need a DOM. */
const JUST_BASH = ["tar", "yq", "xan", "sqlite3", "html-to-markdown"];

/** Programs agents reach for that only a Linux machine has, with the reason a microVM is needed. */
const PROGRAMS = {
	git: "git isn't available in an isolate",
	gh: "the GitHub CLI isn't available in an isolate",
	apt: "installing system packages needs a microVM",
	"apt-get": "installing system packages needs a microVM",
	dpkg: "installing system packages needs a microVM",
	apk: "installing system packages needs a microVM",
	yum: "installing system packages needs a microVM",
	dnf: "installing system packages needs a microVM",
	brew: "installing system packages needs a microVM",
	sudo: "an isolate has no root and no system to change",
	docker: "Docker needs a microVM",
	"docker-compose": "Docker needs a microVM",
	podman: "containers need a microVM",
	pip: "installing Python packages needs a microVM",
	pip3: "installing Python packages needs a microVM",
	uv: "installing Python packages needs a microVM",
	poetry: "installing Python packages needs a microVM",
	conda: "installing Python packages needs a microVM",
	npm: "installing npm packages needs a microVM",
	npx: "running npm packages needs a microVM",
	pnpm: "installing npm packages needs a microVM",
	yarn: "installing npm packages needs a microVM",
	bun: "Bun isn't available in an isolate",
	deno: "Deno isn't available in an isolate",
	tsc: "the TypeScript compiler isn't available in an isolate",
	make: "building software needs a microVM",
	cmake: "building software needs a microVM",
	gcc: "compiling native code needs a microVM",
	"g++": "compiling native code needs a microVM",
	cc: "compiling native code needs a microVM",
	clang: "compiling native code needs a microVM",
	cargo: "Rust needs a microVM",
	rustc: "Rust needs a microVM",
	go: "Go needs a microVM",
	java: "Java needs a microVM",
	javac: "Java needs a microVM",
	mvn: "Java needs a microVM",
	gradle: "Java needs a microVM",
	ruby: "Ruby needs a microVM",
	gem: "Ruby needs a microVM",
	perl: "Perl needs a microVM",
	php: "PHP needs a microVM",
	ssh: "an isolate can't open SSH connections",
	scp: "an isolate can't open SSH connections",
	rsync: "rsync needs a microVM",
	zip: "zip isn't available in an isolate",
	unzip: "unzip isn't available in an isolate",
	ffmpeg: "ffmpeg needs a microVM",
	psql: "database clients need a microVM",
	mysql: "database clients need a microVM",
	"redis-cli": "database clients need a microVM",
	kubectl: "kubectl needs a microVM",
	terraform: "terraform needs a microVM",
	systemctl: "an isolate has no system services",
	chromium: "a browser needs a microVM",
	playwright: "a browser needs a microVM",
};

export const UNAVAILABLE = [...JUST_BASH.map((name) => [name, `${name} isn't available in an isolate's shell`]), ...Object.entries(PROGRAMS)];

export const message = (name) =>
	`${name}: not available in an isolate, which runs only its shell's own commands, node and python. Use a microVM.\n`;
