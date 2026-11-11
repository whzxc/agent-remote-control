//! One interface policy for offers, listeners, discovery and local IPv6 scopes.
use super::*;

pub(super) fn usable(interface: &if_addrs::Interface) -> bool {
    let name = interface.name.to_ascii_lowercase();
    interface.is_oper_up()
        && !interface.is_loopback()
        && !interface.is_p2p()
        && lan_address(interface.ip())
        && ![
            "utun",
            "tun",
            "tap",
            "awdl",
            "llw",
            "bridge",
            "veth",
            "docker",
            "virbr",
            "vmnet",
            "vbox",
            "tailscale",
            "wg",
            "ipsec",
            "gif",
            "stf",
            "sit",
            "zt",
            "ham",
            "vnic",
            "vethernet",
            "hyper-v",
            "virtual",
            "vpn",
            "wireguard",
        ]
        .iter()
        .any(|prefix| name.starts_with(prefix))
}
pub(super) fn lan_interfaces() -> Result<Vec<if_addrs::Interface>> {
    Ok(if_addrs::get_if_addrs()
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(usable)
        .filter(physical)
        .collect())
}
fn physical(interface: &if_addrs::Interface) -> bool {
    #[cfg(target_os = "linux")]
    {
        std::path::Path::new("/sys/class/net")
            .join(&interface.name)
            .join("device")
            .exists()
    }
    #[cfg(target_os = "macos")]
    {
        interface
            .name
            .strip_prefix("en")
            .is_some_and(|suffix| !suffix.is_empty() && suffix.bytes().all(|b| b.is_ascii_digit()))
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::NetworkManagement::IpHelper::{GetIfEntry2, MIB_IF_ROW2};
        let Some(index) = interface.index else {
            return false;
        };
        let mut row = MIB_IF_ROW2 {
            InterfaceIndex: index,
            ..Default::default()
        };
        // HardwareInterface is the first bit; FilterInterface is the second bit.
        unsafe { GetIfEntry2(&mut row) == 0 && row.InterfaceAndOperStatusFlags._bitfield & 3 == 1 }
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    {
        let _ = interface;
        false
    }
}
pub(super) fn rank(address: &SocketAddr) -> u8 {
    match address.ip() {
        IpAddr::V4(ip) if ip.is_private() => 0,
        IpAddr::V6(ip) if (ip.segments()[0] & 0xfe00) == 0xfc00 => 1,
        _ => 2,
    }
}
pub(super) fn sort(addresses: &mut Vec<SocketAddr>) {
    addresses.sort_by_key(|address| (rank(address), *address));
    addresses.dedup();
}
pub(super) fn lan_sockets(port: u16) -> Result<Vec<SocketAddr>> {
    let mut sockets = lan_interfaces()?
        .into_iter()
        .map(|interface| match interface.ip() {
            IpAddr::V6(ip) if ip.is_unicast_link_local() => SocketAddr::V6(
                std::net::SocketAddrV6::new(ip, port, 0, interface.index.unwrap_or(0)),
            ),
            ip => SocketAddr::new(ip, port),
        })
        .collect();
    sort(&mut sockets);
    Ok(sockets)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_up_lan_interfaces_survive() {
        // Property: advertised addresses come only from up nonvirtual nonpoint-to-point LAN interfaces and are unique in preference order.
        let base = if_addrs::Interface {
            name: "en0".into(),
            index: Some(1),
            oper_status: if_addrs::IfOperStatus::Up,
            is_p2p: false,
            addr: if_addrs::IfAddr::V4(if_addrs::Ifv4Addr {
                ip: "192.168.1.2".parse().unwrap(),
                netmask: "255.255.255.0".parse().unwrap(),
                broadcast: None,
                prefixlen: 24,
            }),
            #[cfg(windows)]
            adapter_name: String::new(),
        };
        assert!(usable(&base));
        for name in [
            "utun4",
            "awdl0",
            "llw0",
            "bridge0",
            "veth5",
            "docker0",
            "vmnet1",
            "vEthernet",
        ] {
            let mut interface = base.clone();
            interface.name = name.into();
            assert!(!usable(&interface));
        }
        let mut interface = base.clone();
        interface.is_p2p = true;
        assert!(!usable(&interface));
        interface = base.clone();
        interface.oper_status = if_addrs::IfOperStatus::Down;
        assert!(!usable(&interface));
        interface = base;
        if let if_addrs::IfAddr::V4(ref mut address) = interface.addr {
            address.ip = "8.8.8.8".parse().unwrap();
        }
        assert!(!usable(&interface));
        let mut addresses = [
            "[fe80::1%1]:7143",
            "[fd00::1]:7143",
            "192.168.1.2:7143",
            "192.168.1.2:7143",
        ]
        .map(|s| s.parse().unwrap())
        .to_vec();
        sort(&mut addresses);
        assert_eq!(addresses.len(), 3);
        assert!(addresses.windows(2).all(|w| rank(&w[0]) <= rank(&w[1])));
    }
}
