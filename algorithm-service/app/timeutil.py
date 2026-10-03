from datetime import datetime, timedelta


def iso_to_minutes(dt, sim_start):
    # dt, sim_start: tz-aware datetime; returns integer minutes relative to sim_start
    return int(round((dt - sim_start).total_seconds() / 60.0))


def minutes_to_iso(minutes, sim_start):
    return (sim_start + timedelta(minutes=int(minutes))).isoformat()
