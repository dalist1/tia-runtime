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

enum { READ_CHUNK_SIZE = 1 << 20 };

static void fail(const char *message) {
	perror(message);
	exit(errno ? errno : 1);
}

static void fail_message(const char *message) {
	fprintf(stderr, "%s\n", message);
	exit(1);
}

static char *read_all(const char *path, size_t *size_out) {
	int fd = open(path, O_RDONLY | O_CLOEXEC);
	if (fd < 0) fail("open input");

	struct stat st;
	if (fstat(fd, &st) != 0) fail("fstat input");

	size_t capacity = st.st_size > 0 ? (size_t)st.st_size + 1 : READ_CHUNK_SIZE;
	char *buffer = malloc(capacity);
	if (!buffer) fail("malloc input");

	size_t size = 0;
	for (;;) {
		if (size == capacity) {
			size_t next_capacity = capacity < READ_CHUNK_SIZE ? READ_CHUNK_SIZE : capacity * 2;
			char *next = realloc(buffer, next_capacity);
			if (!next) fail("realloc input");
			buffer = next;
			capacity = next_capacity;
		}

		ssize_t bytes_read = read(fd, buffer + size, capacity - size);
		if (bytes_read == 0) break;
		if (bytes_read < 0) {
			if (errno == EINTR) continue;
			fail("read input");
		}
		size += (size_t)bytes_read;
	}

	close(fd);
	buffer[size] = '\0';
	*size_out = size;
	return buffer;
}

static void write_all_fd(int fd, const char *buffer, size_t size) {
	size_t written = 0;
	while (written < size) {
		ssize_t bytes_written = write(fd, buffer + written, size - written);
		if (bytes_written < 0) {
			if (errno == EINTR) continue;
			fail("write output");
		}
		written += (size_t)bytes_written;
	}
}

int main(int argc, char **argv) {
	if (argc != 4) {
		fprintf(stderr, "usage: %s <target> <old-text-file> <new-text-file>\n", argv[0]);
		return 1;
	}

	const char *target_path = argv[1];
	const char *old_text_path = argv[2];
	const char *new_text_path = argv[3];

	size_t target_size = 0;
	size_t old_size = 0;
	size_t new_size = 0;
	char *target = read_all(target_path, &target_size);
	char *old_text = read_all(old_text_path, &old_size);
	char *new_text = read_all(new_text_path, &new_size);

	if (old_size == 0) fail_message("oldText must not be empty");

	char *first = NULL;
	for (size_t i = 0; i + old_size <= target_size; i += 1) {
		if (memcmp(target + i, old_text, old_size) == 0) {
			if (first) fail_message("oldText not unique");
			first = target + i;
		}
	}

	if (!first) fail_message("oldText not found");

	size_t prefix_size = (size_t)(first - target);
	size_t suffix_offset = prefix_size + old_size;
	size_t suffix_size = target_size - suffix_offset;
	size_t output_size = prefix_size + new_size + suffix_size;

	char tmp_path[4096];
	int tmp_len = snprintf(tmp_path, sizeof(tmp_path), "%s.tmp.%ld", target_path, (long)getpid());
	if (tmp_len <= 0 || (size_t)tmp_len >= sizeof(tmp_path)) fail_message("temporary path too long");

	int out_fd = open(tmp_path, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0644);
	if (out_fd < 0) fail("open tmp output");

	write_all_fd(out_fd, target, prefix_size);
	write_all_fd(out_fd, new_text, new_size);
	write_all_fd(out_fd, target + suffix_offset, suffix_size);

	if (fsync(out_fd) != 0) fail("fsync output");
	if (close(out_fd) != 0) fail("close output");
	if (rename(tmp_path, target_path) != 0) fail("rename output");

	free(target);
	free(old_text);
	free(new_text);

	printf("{\"ok\":true,\"bytes\":%zu}\n", output_size);
	return 0;
}
