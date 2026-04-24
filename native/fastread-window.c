#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <fcntl.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

enum { BUFFER_SIZE = 1 << 16 };

typedef struct {
	char *data;
	size_t len;
	size_t cap;
} buffer_t;

static void fail(const char *message) {
	perror(message);
	exit(errno ? errno : 1);
}

static void ensure_capacity(buffer_t *buffer, size_t needed) {
	if (needed <= buffer->cap) return;
	size_t next = buffer->cap == 0 ? BUFFER_SIZE : buffer->cap;
	while (next < needed) {
		next *= 2;
	}
	char *data = realloc(buffer->data, next);
	if (!data) fail("realloc");
	buffer->data = data;
	buffer->cap = next;
}

static void append_bytes(buffer_t *buffer, const char *src, size_t count) {
	ensure_capacity(buffer, buffer->len + count + 1);
	memcpy(buffer->data + buffer->len, src, count);
	buffer->len += count;
	buffer->data[buffer->len] = '\0';
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

static size_t format_size(size_t bytes, char *out, size_t out_size) {
	const char *units[] = {"B", "KB", "MB", "GB"};
	double value = (double)bytes;
	size_t unit = 0;
	while (value >= 1024.0 && unit < 3) {
		value /= 1024.0;
		unit += 1;
	}
	if (unit == 0) {
		return (size_t)snprintf(out, out_size, "%zu %s", bytes, units[unit]);
	}
	return (size_t)snprintf(out, out_size, "%.1f %s", value, units[unit]);
}

int main(int argc, char **argv) {
	if (argc != 4) {
		fprintf(stderr, "usage: %s <file> <offset> <limit>\n", argv[0]);
		return 1;
	}

	const char *path = argv[1];
	long offset_long = strtol(argv[2], NULL, 10);
	long limit_long = strtol(argv[3], NULL, 10);
	if (offset_long < 1 || limit_long < 1) {
		fprintf(stderr, "offset and limit must be >= 1\n");
		return 1;
	}

	size_t start_line = (size_t)offset_long;
	size_t max_lines = (size_t)limit_long;
	const size_t max_bytes = 256000;

	int fd = open(path, O_RDONLY | O_CLOEXEC);
	if (fd < 0) fail("open");

	char chunk[BUFFER_SIZE];
	buffer_t carry = {0};
	size_t current_line = 1;
	size_t output_lines = 0;
	size_t output_bytes = 0;
	bool hit_line_limit = false;
	bool hit_byte_limit = false;
	bool wrote_output = false;
	size_t first_line_excess = 0;

	for (;;) {
		ssize_t bytes_read = read(fd, chunk, sizeof(chunk));
		if (bytes_read == 0) break;
		if (bytes_read < 0) {
			if (errno == EINTR) continue;
			fail("read");
		}

		append_bytes(&carry, chunk, (size_t)bytes_read);
		size_t line_start = 0;

		for (size_t i = 0; i < carry.len; i += 1) {
			if (carry.data[i] != '\n') continue;
			size_t line_len = i - line_start + 1;
			if (current_line >= start_line) {
				if (output_lines >= max_lines) {
					hit_line_limit = true;
					goto done;
				}
				if (output_bytes + line_len > max_bytes) {
					hit_byte_limit = true;
					if (output_lines == 0) first_line_excess = line_len;
					goto done;
				}
				write_all(STDOUT_FILENO, carry.data + line_start, line_len);
				wrote_output = true;
				output_lines += 1;
				output_bytes += line_len;
			}
			current_line += 1;
			line_start = i + 1;
		}

		if (line_start > 0) {
			size_t remaining = carry.len - line_start;
			memmove(carry.data, carry.data + line_start, remaining);
			carry.len = remaining;
			carry.data[carry.len] = '\0';
		}
	}

	if (carry.len > 0 && current_line >= start_line) {
		if (output_lines >= max_lines) {
			hit_line_limit = true;
			goto done;
		}
		if (output_bytes + carry.len > max_bytes) {
			hit_byte_limit = true;
			if (output_lines == 0) first_line_excess = carry.len;
			goto done;
		}
		write_all(STDOUT_FILENO, carry.data, carry.len);
		wrote_output = true;
		output_lines += 1;
		output_bytes += carry.len;
	}

done:
	close(fd);

	if (hit_line_limit) {
		char message[256];
		size_t end_line = start_line + output_lines - 1;
		size_t next_offset = end_line + 1;
		int len = snprintf(
			message,
			sizeof(message),
			"\n\n[Showing lines %zu-%zu. Use offset=%zu to continue.]",
			start_line,
			end_line,
			next_offset);
		if (len < 0) fail("snprintf");
		write_all(STDOUT_FILENO, message, (size_t)len);
	} else if (hit_byte_limit) {
		char message[256];
		if (output_lines == 0) {
			char size_buf[64];
			char limit_buf[64];
			format_size(first_line_excess, size_buf, sizeof(size_buf));
			format_size(max_bytes, limit_buf, sizeof(limit_buf));
			int len = snprintf(
				message,
				sizeof(message),
				"[Line %zu is %s, exceeds %s limit.]",
				start_line,
				size_buf,
				limit_buf);
			if (len < 0) fail("snprintf");
			write_all(STDOUT_FILENO, message, (size_t)len);
		} else {
			char limit_buf[64];
			size_t end_line = start_line + output_lines - 1;
			size_t next_offset = end_line + 1;
			format_size(output_bytes, limit_buf, sizeof(limit_buf));
			int len = snprintf(
				message,
				sizeof(message),
				"\n\n[Showing lines %zu-%zu (%s limit). Use offset=%zu to continue.]",
				start_line,
				end_line,
				limit_buf,
				next_offset);
			if (len < 0) fail("snprintf");
			write_all(STDOUT_FILENO, message, (size_t)len);
		}
	}

	(void)wrote_output;
	free(carry.data);
	return 0;
}
