#define _GNU_SOURCE
#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <fcntl.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/sendfile.h>
#include <sys/stat.h>
#include <unistd.h>

enum { BUFFER_SIZE = 1 << 20 };

static void fail(const char *message) {
	perror(message);
	exit(errno ? errno : 1);
}

static void write_all(int fd, const char *buffer, size_t size) {
	size_t written = 0;
	while (written < size) {
		ssize_t bytes_written = write(fd, buffer + written, size - written);
		if (bytes_written < 0) {
			if (errno == EINTR) continue;
			fail("write");
		}
		written += (size_t)bytes_written;
	}
}

static void copy_read_write(int src_fd, int dst_fd) {
	char *buffer = NULL;
	if (posix_memalign((void **)&buffer, 4096, BUFFER_SIZE) != 0) {
		fail("posix_memalign");
	}

#ifdef POSIX_FADV_SEQUENTIAL
	(void)posix_fadvise(src_fd, 0, 0, POSIX_FADV_SEQUENTIAL);
#endif

	for (;;) {
		ssize_t bytes_read = read(src_fd, buffer, BUFFER_SIZE);
		if (bytes_read == 0) break;
		if (bytes_read < 0) {
			if (errno == EINTR) continue;
			free(buffer);
			fail("read");
		}
		write_all(dst_fd, buffer, (size_t)bytes_read);
	}

	free(buffer);
}

static bool copy_copy_file_range(int src_fd, int dst_fd) {
#ifdef __linux__
	for (;;) {
		ssize_t copied = copy_file_range(src_fd, NULL, dst_fd, NULL, 1 << 20, 0);
		if (copied == 0) return true;
		if (copied < 0) {
			if (errno == EINTR) continue;
			if (errno == EXDEV || errno == EINVAL || errno == ENOSYS || errno == EPERM) {
				return false;
			}
			fail("copy_file_range");
		}
	}
#else
	(void)src_fd;
	(void)dst_fd;
	return false;
#endif
}

static bool copy_sendfile_loop(int src_fd, int dst_fd, off_t total_size) {
	if (lseek(src_fd, 0, SEEK_SET) < 0) {
		if (errno == ESPIPE) return false;
		fail("lseek src");
	}
	off_t offset = 0;
	while (offset < total_size) {
		size_t chunk = (size_t)((total_size - offset) > (off_t)(1 << 20) ? (1 << 20) : (total_size - offset));
		ssize_t sent = sendfile(dst_fd, src_fd, &offset, chunk);
		if (sent == 0) return true;
		if (sent < 0) {
			if (errno == EINTR) continue;
			if (errno == EINVAL || errno == ENOSYS || errno == EXDEV) {
				return false;
			}
			fail("sendfile");
		}
	}
	return true;
}

int main(int argc, char **argv) {
	if (argc != 3) {
		fprintf(stderr, "usage: %s <src> <dst>\n", argv[0]);
		return 1;
	}

	const char *src_path = argv[1];
	const char *dst_path = argv[2];
	int src_fd = open(src_path, O_RDONLY | O_CLOEXEC);
	if (src_fd < 0) fail("open src");

	struct stat st;
	if (fstat(src_fd, &st) != 0) fail("fstat src");

	int dst_fd = open(dst_path, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, st.st_mode & 0777);
	if (dst_fd < 0) fail("open dst");

	bool copied = copy_copy_file_range(src_fd, dst_fd);
	if (!copied) {
		copied = copy_sendfile_loop(src_fd, dst_fd, st.st_size);
	}
	if (!copied) {
		if (lseek(src_fd, 0, SEEK_SET) < 0) fail("lseek src reset");
		copy_read_write(src_fd, dst_fd);
	}

	if (fsync(dst_fd) != 0) fail("fsync dst");
	if (close(dst_fd) != 0) fail("close dst");
	if (close(src_fd) != 0) fail("close src");

	printf("{\"ok\":true,\"bytes\":%lld}\n", (long long)st.st_size);
	return 0;
}
