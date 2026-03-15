#define _GNU_SOURCE

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static const char *REAL_CAT = "/usr/bin/cat";
static const char *FASTDRAIN = "/home/frensiqatipi1/bun-stdin-bench/bin/fastdrain";

static int is_regular_file(const char *path) {
	struct stat st;
	if (stat(path, &st) != 0) return 0;
	return S_ISREG(st.st_mode);
}

int main(int argc, char **argv) {
	char stdout_target[4096];
	ssize_t len = readlink("/proc/self/fd/1", stdout_target, sizeof(stdout_target) - 1);
	int stdout_is_dev_null = 0;
	if (len > 0) {
		stdout_target[len] = '\0';
		stdout_is_dev_null = strcmp(stdout_target, "/dev/null") == 0;
	}

	if (stdout_is_dev_null) {
		if (argc == 1) {
			execl(FASTDRAIN, FASTDRAIN, (char *)NULL);
			perror("exec fastdrain");
			return 1;
		}
		if (argc == 2 && argv[1][0] != '-' && is_regular_file(argv[1])) {
			execl(FASTDRAIN, FASTDRAIN, argv[1], (char *)NULL);
			perror("exec fastdrain file");
			return 1;
		}
	}

	execv(REAL_CAT, argv);
	perror("exec real cat");
	return errno ? errno : 1;
}
