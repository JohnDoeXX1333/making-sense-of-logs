-- BGL logs table for SereneDB 26.10.1.
CREATE TABLE bgl_logs (
    line_id      BIGINT,
    label        VARCHAR,
    is_alert     BOOLEAN,
    epoch_s      BIGINT,
    event_time   TIMESTAMP,   -- log-local wall time (US Pacific) as printed in BGL
    node         VARCHAR,
    midplane     VARCHAR,
    event_type   VARCHAR,
    component    VARCHAR,
    level        VARCHAR,
    message      VARCHAR,
    raw_line     VARCHAR,
    parse_status VARCHAR
);
