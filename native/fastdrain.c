#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <unistd.h>

enum { BUFFER_SIZE = 1 << 20 };

static char drain_buffer[BUFFER_SIZE];

static int drain_fd(int fd) {
#ifdef POSIX_FADV_SEQUENTIAL
	(void)posix_fadvise(fd, 0, 0, POSIX_FADV_SEQUENTIAL);
#endif

	for (;;) {
		ssize_t bytes_read = read(fd, drain_buffer, BUFFER_SIZE);
		if (bytes_read == 0) {
			break;
		}
		if (bytes_read < 0) {
			if (errno == EINTR) {
				continue;
			}
			perror("read");
			return 1;
		}
	}
	return 0;
}

int main(int argc, char **argv) {
	int fd = STDIN_FILENO;

	if (argc > 2) {
		fprintf(stderr, "usage: %s [file]\n", argv[0]);
		return 1;
	}

	if (argc == 2) {
		fd = open(argv[1], O_RDONLY | O_CLOEXEC);
		if (fd < 0) {
			perror("open");
			return 1;
		}
	}

	int status = drain_fd(fd);

	if (fd != STDIN_FILENO && close(fd) != 0) {
		perror("close");
		status = 1;
	}

	return status;
}
