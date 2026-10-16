use super::*;
// RFC 4180 records, including quoted commas/newlines and doubled quotes.
pub(super) fn parse(bytes: &[u8]) -> Result<Scan, ()> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| ())?
        .trim_start_matches('\u{feff}');
    let mut records = vec![];
    let mut record = vec![];
    let mut cell = String::new();
    let mut quoted = false;
    let mut closed = false;
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if quoted {
            if ch == '"' {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    cell.push('"')
                } else {
                    quoted = false;
                    closed = true
                }
            } else {
                cell.push(ch)
            }
        } else {
            match ch {
                '"' if cell.is_empty() && !closed => quoted = true,
                ',' => {
                    record.push(std::mem::take(&mut cell));
                    closed = false
                }
                '\n' => {
                    record.push(std::mem::take(&mut cell));
                    records.push(std::mem::take(&mut record));
                    closed = false
                }
                '\r' if chars.peek() == Some(&'\n') => (),
                _ if closed => return Err(()),
                _ => cell.push(ch),
            }
        }
    }
    if quoted {
        return Err(());
    }
    if !cell.is_empty() || !record.is_empty() {
        record.push(cell);
        records.push(record)
    }
    let header = records.first().ok_or(())?;
    let columns = [
        "Date",
        "Model",
        "Input (w/ Cache Write)",
        "Input (w/o Cache Write)",
        "Cache Read",
        "Output Tokens",
    ];
    let mut indexes = vec![];
    for key in columns {
        let positions: Vec<_> = header
            .iter()
            .enumerate()
            .filter(|(_, v)| v.as_str() == key)
            .map(|(i, _)| i)
            .collect();
        if positions.len() != 1 {
            return Err(());
        }
        indexes.push(positions[0]);
    }
    let mut out = Scan::default();
    for row in records.iter().skip(1) {
        if row.len() == 1 && row[0].is_empty() {
            continue;
        }
        let parse = || -> Option<Event> {
            if row.len() != header.len() {
                return None;
            }
            let value = |i: usize| row.get(indexes[i]).map(|s| s.trim());
            let n = |i| {
                let s = value(i)?;
                if s.is_empty() {
                    Some(0)
                } else {
                    s.parse::<u64>().ok()
                }
            };
            let model = value(1)?.to_owned();
            if model.is_empty() {
                return None;
            }
            Some(Event {
                write_hour: 0,
                at: time(value(0)?)?,
                model,
                input: n(3)?,
                cached: n(4)?,
                output: n(5)?,
                write: n(2)?,
                fast: false,
            })
        };
        if let Some(e) = parse() {
            out.events.push(e)
        } else {
            out.incomplete = true
        }
    }
    Ok(out)
}
