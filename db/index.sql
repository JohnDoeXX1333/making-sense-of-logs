-- Search dictionary and inverted index. Run after the bulk load.
CREATE TEXT SEARCH DICTIONARY log_text AS split_by_non_alpha(case := 'lower') WITH (frequency, position);
CREATE INDEX bgl_idx ON bgl_logs USING inverted (line_id, message log_text, label, node, midplane, component, level, is_alert, event_time) INCLUDE (raw_line, epoch_s);
VACUUM (REFRESH_TABLE) bgl_logs;
