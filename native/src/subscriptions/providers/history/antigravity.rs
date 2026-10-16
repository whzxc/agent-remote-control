use super::*;
enum Field<'a> {
    Number(u64),
    Bytes(&'a [u8]),
}
fn varint(bytes: &[u8], offset: &mut usize) -> Option<u64> {
    let mut n = 0u64;
    for shift in (0..70).step_by(7) {
        let b = *bytes.get(*offset)?;
        *offset += 1;
        if shift == 63 && b > 1 {
            return None;
        }
        n |= ((b & 127) as u64) << shift;
        if b & 128 == 0 {
            return Some(n);
        }
    }
    None
}
fn field(bytes: &[u8], wanted: u64) -> Option<Field<'_>> {
    let mut offset = 0;
    while offset < bytes.len() {
        let tag = varint(bytes, &mut offset)?;
        if tag >> 3 == 0 {
            return None;
        }
        let value = match tag & 7 {
            0 => Field::Number(varint(bytes, &mut offset)?),
            2 => {
                let len = usize::try_from(varint(bytes, &mut offset)?).ok()?;
                let end = offset.checked_add(len)?;
                let b = bytes.get(offset..end)?;
                offset = end;
                Field::Bytes(b)
            }
            1 | 5 => {
                offset = offset.checked_add(if tag & 7 == 1 { 8 } else { 4 })?;
                bytes.get(..offset)?;
                continue;
            }
            _ => return None,
        };
        if tag >> 3 == wanted {
            return Some(value);
        }
    }
    None
}
fn bytes(v: &[u8], n: u64) -> Option<&[u8]> {
    match field(v, n)? {
        Field::Bytes(b) => Some(b),
        _ => None,
    }
}
fn number(v: &[u8], n: u64) -> Option<u64> {
    match field(v, n)? {
        Field::Number(n) => Some(n),
        _ => None,
    }
}
fn event(blob: &[u8], step: Option<&[u8]>) -> Option<Event> {
    let wrap = bytes(blob, 1)?;
    let usage = bytes(wrap, 4)?;
    let id = bytes(wrap, 19)
        .and_then(|b| std::str::from_utf8(b).ok())
        .unwrap_or("");
    let label = bytes(wrap, 21)
        .and_then(|b| std::str::from_utf8(b).ok())
        .unwrap_or("");
    let timestamp = bytes(wrap, 9)
        .and_then(|v| bytes(v, 4))
        .and_then(|v| number(v, 1))
        .or_else(|| step.and_then(|v| bytes(v, 1)).and_then(|v| number(v, 1)))?;
    let input = number(usage, 1)
        .unwrap_or(0)
        .checked_add(number(usage, 2).unwrap_or(0))?;
    let cached = number(usage, 5).unwrap_or(0).min(input);
    let output = number(usage, 3).unwrap_or(0);
    if id.is_empty() && label.is_empty() && output == 0 {
        return None;
    }
    Some(Event {
        write_hour: 0,
        at: i64::try_from(timestamp).ok()?.checked_mul(1000)?,
        model: if id.contains("default") && !label.is_empty() {
            label
        } else {
            id
        }
        .into(),
        input: input - cached,
        cached,
        output,
        write: 0,
        fast: false,
    })
}
pub(super) fn scan(path: &Path) -> Scan {
    let mut out = Scan::default();
    let db = match rusqlite::Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    ) {
        Ok(db) => db,
        Err(_) => {
            out.incomplete = true;
            return out;
        }
    };
    let _ = db.busy_timeout(std::time::Duration::from_secs(2));
    let has: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='gen_metadata')",
            [],
            |r| r.get(0),
        )
        .unwrap_or(false);
    if !has {
        return out;
    }
    let steps: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='steps')",
            [],
            |r| r.get(0),
        )
        .unwrap_or(false);
    let sql = if steps {
        "SELECT CASE WHEN length(g.data)<=1048576 THEN g.data END, (SELECT CASE WHEN length(metadata)<=1048576 THEN metadata END FROM steps WHERE idx=g.idx) FROM gen_metadata g WHERE g.data IS NOT NULL"
    } else {
        "SELECT CASE WHEN length(data)<=1048576 THEN data END, NULL FROM gen_metadata WHERE data IS NOT NULL"
    };
    let Ok(mut stmt) = db.prepare(sql) else {
        out.incomplete = true;
        return out;
    };
    let Ok(rows) = stmt.query_map([], |r| {
        Ok((
            r.get::<_, Option<Vec<u8>>>(0)?,
            r.get::<_, Option<Vec<u8>>>(1)?,
        ))
    }) else {
        out.incomplete = true;
        return out;
    };
    for row in rows {
        match row {
            Ok((Some(blob), step)) => {
                if let Some(e) = event(&blob, step.as_deref()) {
                    out.events.push(e)
                }
            }
            _ => out.incomplete = true,
        }
    }
    out
}
