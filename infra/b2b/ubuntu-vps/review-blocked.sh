#!/bin/sh
# Permanent review gate. No environment value removes it.
printf '%s\n' 'B2B_VPS_REVIEW_BLOCKED: owner runtimes, immutable images and TI approval pending.' >&2
exit 78
