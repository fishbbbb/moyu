import re


class StrictVersion:
    """
    A small subset of distutils.version.StrictVersion.

    This is only intended to satisfy node-gyp's gyp import on
    Python 3.12+ where distutils was removed.
    """

    version_re = re.compile(r"^(\d+)\.(\d+)(?:\.(\d+))?(?:([ab])(\d+))?$")

    def __init__(self, vstring=None):
        self.vstring = ""
        self.version = None
        self.prerelease = None
        if vstring is not None:
            self.parse(vstring)

    def parse(self, vstring):
        vstring = str(vstring).strip()
        m = self.version_re.match(vstring)
        if not m:
            raise ValueError(f"invalid version number '{vstring}'")
        major, minor, patch, pre_l, pre_n = m.groups()
        self.version = (int(major), int(minor), int(patch) if patch is not None else 0)
        if pre_l is None:
            self.prerelease = None
        else:
            self.prerelease = (pre_l, int(pre_n or 0))
        self.vstring = vstring

    def __repr__(self):
        return f"StrictVersion('{self.vstring}')"

    def _cmp(self, other):
        if not isinstance(other, StrictVersion):
            other = StrictVersion(other)
        if self.version != other.version:
            return (self.version > other.version) - (self.version < other.version)
        # prerelease: None > prerelease
        if self.prerelease == other.prerelease:
            return 0
        if self.prerelease is None:
            return 1
        if other.prerelease is None:
            return -1
        return (self.prerelease > other.prerelease) - (self.prerelease < other.prerelease)

    def __lt__(self, other):
        return self._cmp(other) < 0

    def __le__(self, other):
        return self._cmp(other) <= 0

    def __eq__(self, other):
        return self._cmp(other) == 0

    def __ne__(self, other):
        return self._cmp(other) != 0

    def __gt__(self, other):
        return self._cmp(other) > 0

    def __ge__(self, other):
        return self._cmp(other) >= 0

