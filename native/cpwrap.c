#define _GNU_SOURCE

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static const char *REAL_CP = "/bin/cp";
static const char *FASTCOPY = "/home/frensiqatipi1/bun-stdin-bench/opencode-optimized/bin/fastcopy";

static int is_regular_file(const char *path) {
	struct stat st;
	if (stat(path, &st) != 0) return 0;
	return S_ISREG(st.st_mode);
}

int main(int argc, char **argv) {
	if (argc == 3 && argv[1][0] != '-' && argv[2][0] != '-' && is_regular_file(argv[1])) {
		execl(FASTCOPY, FASTCOPY, argv[1], argv[2], (char *)NULL);
		perror("exec fastcopy");
		return 1;
	}

	execv(REAL_CP, argv);
	perror("exec real cp");
	return errno ? errno : 1;
}
