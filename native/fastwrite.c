#define _GNU_SOURCE
#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <fcntl.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define READ_CHUNK_SIZE (1 << 20)

static void fail(const char *message) {
	perror(message);
	exit(errno ? errno : 1);
}

static void fail_message(const char *message) {
	fprintf(stderr, "%s\n", message);
	exit(1);
}

static void write_all_fd(int fd, const char *buffer, size_t size) {
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

static char *read_all_fd(int fd, size_t *size_out) {
	size_t capacity = READ_CHUNK_SIZE;
	size_t size = 0;
	char *buffer = malloc(capacity ? capacity : 1);
	if (!buffer) fail("malloc");

	for (;;) {
		if (size == capacity) {
			if (capacity > ((size_t)-1) / 2) fail_message("input too large");
			capacity *= 2;
			char *next = realloc(buffer, capacity);
			if (!next) fail("realloc");
			buffer = next;
		}

		ssize_t bytes_read = read(fd, buffer + size, capacity - size);
		if (bytes_read == 0) break;
		if (bytes_read < 0) {
			if (errno == EINTR) continue;
			fail("read");
		}
		size += (size_t)bytes_read;
	}

	*size_out = size;
	return buffer;
}

static char *read_file(const char *path, size_t *size_out) {
	int fd = open(path, O_RDONLY | O_CLOEXEC);
	if (fd < 0) fail("open verify");
	char *buffer = read_all_fd(fd, size_out);
	if (close(fd) != 0) fail("close verify");
	return buffer;
}

static void verify_file_exact(const char *path, const char *expected, size_t expected_size, const char *stage) {
	size_t actual_size = 0;
	char *actual = read_file(path, &actual_size);
	if (actual_size != expected_size || memcmp(actual, expected, expected_size) != 0) {
		fprintf(
			stderr,
			"write verification failed after %s: expected %zu bytes, got %zu bytes\n",
			stage,
			expected_size,
			actual_size);
		free(actual);
		exit(1);
	}
	free(actual);
}

static bool is_symlink_path(const char *path) {
	struct stat st;
	if (lstat(path, &st) == 0) return S_ISLNK(st.st_mode);
	if (errno == ENOENT) return false;
	fail("lstat target");
	return false;
}

static mode_t target_mode_or_default(const char *path) {
	struct stat st;
	if (stat(path, &st) == 0) return st.st_mode & 0777;
	if (errno == ENOENT) return 0644;
	fail("stat target");
	return 0644;
}

static void fsync_parent_dir(const char *path) {
	char *copy = strdup(path);
	if (!copy) fail("strdup");
	char *slash = strrchr(copy, '/');
	if (!slash) {
		free(copy);
		return;
	}
	if (slash == copy) {
		slash[1] = '\0';
	} else {
		*slash = '\0';
	}
	int fd = open(copy, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
	if (fd >= 0) {
		if (fsync(fd) != 0) fail("fsync parent");
		if (close(fd) != 0) fail("close parent");
	}
	free(copy);
}

static void write_verified_path(const char *path, const char *content, size_t content_size, mode_t mode) {
	int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, mode);
	if (fd < 0) fail("open output");
	write_all_fd(fd, content, content_size);
	if (fsync(fd) != 0) fail("fsync output");
	if (close(fd) != 0) fail("close output");
	verify_file_exact(path, content, content_size, "write");
}

int main(int argc, char **argv) {
	if (argc != 2) {
		fprintf(stderr, "usage: %s <target> < stdin\n", argv[0]);
		return 1;
	}

	const char *target_path = argv[1];
	size_t content_size = 0;
	char *content = read_all_fd(STDIN_FILENO, &content_size);

	if (is_symlink_path(target_path)) {
		write_verified_path(target_path, content, content_size, 0644);
		printf("{\"ok\":true,\"bytes\":%zu,\"mode\":\"symlink\"}\n", content_size);
		free(content);
		return 0;
	}

	mode_t mode = target_mode_or_default(target_path);
	char tmp_path[4096];
	int tmp_len = snprintf(tmp_path, sizeof(tmp_path), "%s.tmp.%ld", target_path, (long)getpid());
	if (tmp_len <= 0 || (size_t)tmp_len >= sizeof(tmp_path)) fail_message("temporary path too long");

	write_verified_path(tmp_path, content, content_size, mode);
	if (rename(tmp_path, target_path) != 0) {
		unlink(tmp_path);
		fail("rename output");
	}
	fsync_parent_dir(target_path);
	verify_file_exact(target_path, content, content_size, "rename");

	printf("{\"ok\":true,\"bytes\":%zu,\"mode\":\"atomic\"}\n", content_size);
	free(content);
	return 0;
}
