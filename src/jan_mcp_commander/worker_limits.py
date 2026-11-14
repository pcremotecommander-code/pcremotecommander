"""Process-local parser limits; callers also enforce an external deadline."""
import os
import time


def remaining(deadline,maximum):
    seconds=maximum if deadline is None else min(maximum,deadline-time.monotonic())
    if seconds<=0:raise ValueError('Processing deadline exceeded; no output saved')
    return seconds


def apply_limits(megabytes, cpu_seconds=None):
    size = megabytes * 1024 * 1024
    if os.name == 'nt':
        import win32api
        import win32job
        job = win32job.CreateJobObject(None, '')
        limits = win32job.QueryInformationJobObject(job, win32job.JobObjectExtendedLimitInformation)
        limits['BasicLimitInformation']['LimitFlags'] = win32job.JOB_OBJECT_LIMIT_PROCESS_MEMORY
        if cpu_seconds is not None:
            limits['BasicLimitInformation']['LimitFlags'] |= win32job.JOB_OBJECT_LIMIT_PROCESS_TIME
            limits['BasicLimitInformation']['PerProcessUserTimeLimit'] = int(cpu_seconds*10_000_000)
        limits['ProcessMemoryLimit'] = size
        win32job.SetInformationJobObject(job, win32job.JobObjectExtendedLimitInformation, limits)
        win32job.AssignProcessToJobObject(job, win32api.GetCurrentProcess())
        return job
    import resource
    resource.setrlimit(resource.RLIMIT_AS, (size, size))
    if cpu_seconds is not None:resource.setrlimit(resource.RLIMIT_CPU,(cpu_seconds,cpu_seconds))
