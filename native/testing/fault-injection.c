#define _GNU_SOURCE

#include <dlfcn.h>
#include <errno.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/sendfile.h>
#include <sys/types.h>
#include <unistd.h>

static long copy_file_range_total;
static long sendfile_total;
static bool pread_corrupted;
static bool rename_failed;

static long env_long(const char *name, long fallback) {
	const char *value = getenv(name);
	if (!value || !*value) return fallback;
	char *end = NULL;
	long parsed = strtol(value, &end, 10);
	return end && *end == '\0' ? parsed : fallback;
}

ssize_t write(int fd, const void *buffer, size_t count) {
	static ssize_t (*next_write)(int, const void *, size_t);
	if (!next_write) next_write = dlsym(RTLD_NEXT, "write");
	long maximum = env_long("TIA_FAULT_WRITE_MAX", -1);
	if (maximum >= 0 && count > (size_t)maximum) count = (size_t)maximum;
	return next_write(fd, buffer, count);
}

ssize_t pread(int fd, void *buffer, size_t count, off_t offset) {
	static ssize_t (*next_pread)(int, void *, size_t, off_t);
	if (!next_pread) next_pread = dlsym(RTLD_NEXT, "pread");
	ssize_t result = next_pread(fd, buffer, count, offset);
	if (result > 0 && !pread_corrupted && getenv("TIA_FAULT_PREAD_CORRUPT")) {
		((unsigned char *)buffer)[0] ^= 1;
		pread_corrupted = true;
	}
	return result;
}

ssize_t copy_file_range(int source, off64_t *source_offset, int destination, off64_t *destination_offset, size_t count, unsigned int flags) {
	static ssize_t (*next_copy_file_range)(int, off64_t *, int, off64_t *, size_t, unsigned int);
	if (!next_copy_file_range) next_copy_file_range = dlsym(RTLD_NEXT, "copy_file_range");
	long fail_after = env_long("TIA_FAULT_COPY_FILE_RANGE_AFTER", -1);
	if (fail_after >= 0) {
		if (copy_file_range_total >= fail_after) {
			errno = EXDEV;
			return -1;
		}
		long remaining = fail_after - copy_file_range_total;
		if (count > (size_t)remaining) count = (size_t)remaining;
	}
	ssize_t result = next_copy_file_range(source, source_offset, destination, destination_offset, count, flags);
	if (result > 0) copy_file_range_total += result;
	return result;
}

ssize_t sendfile(int destination, int source, off_t *offset, size_t count) {
	static ssize_t (*next_sendfile)(int, int, off_t *, size_t);
	if (!next_sendfile) next_sendfile = dlsym(RTLD_NEXT, "sendfile");
	long fail_after = env_long("TIA_FAULT_SENDFILE_AFTER", -1);
	if (fail_after >= 0) {
		if (sendfile_total >= fail_after) {
			errno = EINVAL;
			return -1;
		}
		long remaining = fail_after - sendfile_total;
		if (count > (size_t)remaining) count = (size_t)remaining;
	}
	ssize_t result = next_sendfile(destination, source, offset, count);
	if (result > 0) sendfile_total += result;
	return result;
}

int rename(const char *source, const char *destination) {
	static int (*next_rename)(const char *, const char *);
	if (!next_rename) next_rename = dlsym(RTLD_NEXT, "rename");
	if (!rename_failed && getenv("TIA_FAULT_RENAME") && strstr(source, ".tmp.")) {
		rename_failed = true;
		errno = EINTR;
		return -1;
	}
	return next_rename(source, destination);
}
