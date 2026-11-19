//! A small strict JSON parser that keeps object key order and tells integers
//! from floats (a number token with no '.', 'e' or 'E' is an integer).

use toon_encode::Value;

pub fn parse(src: &str) -> Result<Value, String> {
    let mut p = P {
        b: src.as_bytes(),
        i: 0,
    };
    p.ws();
    let v = p.value()?;
    p.ws();
    if p.i != p.b.len() {
        return Err(format!("trailing data at {}", p.i));
    }
    Ok(v)
}

struct P<'a> {
    b: &'a [u8],
    i: usize,
}

impl P<'_> {
    fn ws(&mut self) {
        while matches!(self.b.get(self.i), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.i += 1;
        }
    }

    fn eat(&mut self, lit: &str) -> bool {
        if self.b[self.i..].starts_with(lit.as_bytes()) {
            self.i += lit.len();
            true
        } else {
            false
        }
    }

    fn value(&mut self) -> Result<Value, String> {
        match self.b.get(self.i) {
            None => Err("unexpected end".into()),
            Some(b'{') => self.object(),
            Some(b'[') => self.array(),
            Some(b'"') => Ok(Value::Str(self.string()?)),
            Some(b't') if self.eat("true") => Ok(Value::Bool(true)),
            Some(b'f') if self.eat("false") => Ok(Value::Bool(false)),
            Some(b'n') if self.eat("null") => Ok(Value::Null),
            Some(b'-' | b'0'..=b'9') => self.number(),
            Some(c) => Err(format!("unexpected {:?} at {}", *c as char, self.i)),
        }
    }

    fn number(&mut self) -> Result<Value, String> {
        let start = self.i;
        let mut is_float = false;
        if self.b[self.i] == b'-' {
            self.i += 1;
        }
        while let Some(c) = self.b.get(self.i) {
            match c {
                b'0'..=b'9' => {}
                b'.' | b'e' | b'E' | b'+' | b'-' => is_float = true,
                _ => break,
            }
            self.i += 1;
        }
        let tok = std::str::from_utf8(&self.b[start..self.i]).map_err(|e| e.to_string())?;
        if !is_float {
            if let Ok(i) = tok.parse::<i64>() {
                return Ok(Value::Int(i));
            }
        }
        tok.parse::<f64>()
            .map(Value::Num)
            .map_err(|e| format!("bad number {tok:?}: {e}"))
    }

    fn hex4(&mut self) -> Result<u32, String> {
        let h = self.b.get(self.i..self.i + 4).ok_or("short \\u escape")?;
        let h = std::str::from_utf8(h).map_err(|e| e.to_string())?;
        self.i += 4;
        u32::from_str_radix(h, 16).map_err(|e| e.to_string())
    }

    fn string(&mut self) -> Result<String, String> {
        self.i += 1;
        let mut out = String::new();
        loop {
            let c = *self.b.get(self.i).ok_or("unterminated string")?;
            match c {
                b'"' => {
                    self.i += 1;
                    return Ok(out);
                }
                b'\\' => {
                    let e = *self.b.get(self.i + 1).ok_or("bad escape")?;
                    self.i += 2;
                    match e {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{8}'),
                        b'f' => out.push('\u{c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let mut cp = self.hex4()?;
                            if (0xD800..0xDC00).contains(&cp) {
                                if !self.eat("\\u") {
                                    return Err("lone high surrogate".into());
                                }
                                let lo = self.hex4()?;
                                if !(0xDC00..0xE000).contains(&lo) {
                                    return Err("bad low surrogate".into());
                                }
                                cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                            }
                            out.push(char::from_u32(cp).ok_or("bad code point")?);
                        }
                        _ => return Err(format!("bad escape \\{}", e as char)),
                    }
                }
                c if c < 0x20 => return Err("control char in string".into()),
                _ => {
                    // Copy one full UTF-8 sequence.
                    let rest = std::str::from_utf8(&self.b[self.i..]).map_err(|e| e.to_string())?;
                    let ch = rest.chars().next().ok_or("eof")?;
                    out.push(ch);
                    self.i += ch.len_utf8();
                }
            }
        }
    }

    fn array(&mut self) -> Result<Value, String> {
        self.i += 1;
        let mut items = Vec::new();
        self.ws();
        if self.eat("]") {
            return Ok(Value::Array(items));
        }
        loop {
            self.ws();
            items.push(self.value()?);
            self.ws();
            if self.eat(",") {
                continue;
            }
            if self.eat("]") {
                return Ok(Value::Array(items));
            }
            return Err(format!("expected , or ] at {}", self.i));
        }
    }

    fn object(&mut self) -> Result<Value, String> {
        self.i += 1;
        let mut items = Vec::new();
        self.ws();
        if self.eat("}") {
            return Ok(Value::Object(items));
        }
        loop {
            self.ws();
            if self.b.get(self.i) != Some(&b'"') {
                return Err(format!("expected key at {}", self.i));
            }
            let k = self.string()?;
            self.ws();
            if !self.eat(":") {
                return Err(format!("expected : at {}", self.i));
            }
            self.ws();
            let v = self.value()?;
            items.push((k, v));
            self.ws();
            if self.eat(",") {
                continue;
            }
            if self.eat("}") {
                return Ok(Value::Object(items));
            }
            return Err(format!("expected , or }} at {}", self.i));
        }
    }
}
