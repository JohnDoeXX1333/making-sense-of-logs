import sys, collections
path = sys.argv[1]
bad_utf8 = []; crlf = 0; fieldcounts = collections.Counter(); labels = collections.Counter()
levels = collections.Counter(); comps = collections.Counter(); types = collections.Counter()
dbl_space_head = 0; node_ne_repeat = 0; short = []
with open(path, 'rb') as f:
    for n, raw in enumerate(f, 1):
        if raw.endswith(b'\r\n'): crlf += 1
        try:
            line = raw.decode('utf-8')
        except UnicodeDecodeError as e:
            bad_utf8.append((n, raw[max(0, e.start-20):e.end+20]))
            line = raw.decode('utf-8', 'replace')
        line = line.rstrip('\r\n')
        parts = line.split(' ', 9)
        fieldcounts[len(parts)] += 1
        if len(parts) < 10:
            if len(short) < 5: short.append((n, line[:160]))
            continue
        if '' in parts[:9]: dbl_space_head += 1
        labels[parts[0]] += 1; types[parts[6]] += 1; comps[parts[7]] += 1; levels[parts[8]] += 1
        if parts[3] != parts[5]: node_ne_repeat += 1
print('lines', n, 'crlf', crlf, 'bad_utf8', len(bad_utf8), bad_utf8[:5])
print('fieldcounts', dict(fieldcounts), 'empty field in head', dbl_space_head, 'node!=repeat', node_ne_repeat)
print('short examples', short)
print('alerts', sum(v for k, v in labels.items() if k != '-'), 'label kinds', len(labels) - 1)
print('top labels', labels.most_common(12))
print('types', types.most_common(8)); print('components', comps.most_common(10)); print('levels', levels.most_common(10))
