#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/sendfile.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

static int copy_regular_file(const char *src_path, const char *dst_path) {
	int src_fd = open(src_path, O_RDONLY | O_CLOEXEC);
	if (src_fd < 0) {
		perror("open src");
		return 1;
	}

	struct stat st;
	if (fstat(src_fd, &st) != 0) {
		perror("fstat src");
		close(src_fd);
		return 1;
	}

	int dst_fd = open(dst_path, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, st.st_mode & 0777);
	if (dst_fd < 0) {
		perror("open dst");
		close(src_fd);
		return 1;
	}

	off_t offset = 0;
	while (offset < st.st_size) {
		ssize_t sent = sendfile(dst_fd, src_fd, &offset, (size_t)(st.st_size - offset));
		if (sent > 0) {
			continue;
		}
		if (sent < 0 && errno == EINTR) {
			continue;
		}
		if (sent < 0 && (errno == EINVAL || errno == ENOSYS)) {
			break;
		}
		perror("sendfile");
		close(dst_fd);
		close(src_fd);
		return 1;
	}

	if (offset < st.st_size) {
		if (lseek(src_fd, offset, SEEK_SET) < 0) {
			perror("lseek");
			close(dst_fd);
			close(src_fd);
			return 1;
		}

		char buffer[1 << 20];
		for (;;) {
			ssize_t bytes_read = read(src_fd, buffer, sizeof(buffer));
			if (bytes_read == 0) {
				break;
			}
			if (bytes_read < 0) {
				if (errno == EINTR) {
					continue;
				}
				perror("read");
				close(dst_fd);
				close(src_fd);
				return 1;
			}
			char *cursor = buffer;
			ssize_t remaining = bytes_read;
			while (remaining > 0) {
				ssize_t written = write(dst_fd, cursor, (size_t)remaining);
				if (written < 0) {
					if (errno == EINTR) {
						continue;
					}
					perror("write");
					close(dst_fd);
					close(src_fd);
					return 1;
				}
				cursor += written;
				remaining -= written;
			}
		}
	}

	if (close(dst_fd) != 0) {
		perror("close dst");
		close(src_fd);
		return 1;
	}

	if (close(src_fd) != 0) {
		perror("close src");
		return 1;
	}

	return 0;
}

int main(int argc, char **argv) {
	if (argc != 3) {
		fprintf(stderr, "usage: %s <src> <dst>\n", argv[0]);
		return 1;
	}

	return copy_regular_file(argv[1], argv[2]);
}
