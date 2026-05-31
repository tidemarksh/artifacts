FROM ubuntu:24.04@sha256:c4a8d5503dfb2a3eb8ab5f807da5bc69a85730fb49b5cfca2330194ebcc41c7b AS toolchain

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
    build-essential \
    git \
    wget \
    xz-utils \
    bzip2 \
    python3 \
    texinfo \
    bison \
    flex \
    file \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN git clone https://github.com/richfelker/musl-cross-make.git /mcm \
    && cd /mcm \
    && git checkout e5147dde912478dd32ad42a25003e82d4f5733aa

WORKDIR /mcm

RUN printf '%s\n' \
    'TARGET = riscv64-linux-musl' \
    'GCC_VER = 14.2.0' \
    'BINUTILS_VER = 2.44' \
    'MUSL_VER = 1.2.5' \
    'GCC_CONFIG += --with-arch=rv64gc --with-abi=lp64d' \
    'GNU_SITE = https://ftp.gnu.org/gnu' \
    > config.mak

RUN make -j$(nproc) install OUTPUT=/opt/cross

WORKDIR /tmp
RUN apt-get update && apt-get install -y rsync \
    && rm -rf /var/lib/apt/lists/*
RUN wget -q https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-6.6.68.tar.xz \
    && printf '%s  %s\n' \
      283ff410e3f352ceed161ae30c0020301326059db03e86efcb384d46ac5840e2 \
      linux-6.6.68.tar.xz | sha256sum -c - \
    && tar xf linux-6.6.68.tar.xz \
    && cd linux-6.6.68 \
    && make ARCH=riscv headers_install INSTALL_HDR_PATH=/opt/cross/riscv64-linux-musl/usr \
    && cd /tmp \
    && rm -rf /tmp/linux-6.6.68 /tmp/linux-6.6.68.tar.xz

FROM ubuntu:24.04@sha256:c4a8d5503dfb2a3eb8ab5f807da5bc69a85730fb49b5cfca2330194ebcc41c7b AS builder

ENV DEBIAN_FRONTEND=noninteractive
ENV PATH="/opt/cross/bin:${PATH}"
ENV SOURCE_DATE_EPOCH=1775204742

RUN apt-get update && apt-get install -y \
    build-essential \
    wget \
    bzip2 \
    make \
    file \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=toolchain /opt/cross /opt/cross

WORKDIR /build

RUN wget -q https://busybox.net/downloads/busybox-1.37.0.tar.bz2 \
    && printf '%s  %s\n' \
      3311dff32e746499f4df0d5df04d7eb396382d7e108bb9250e7b519b837043a4 \
      busybox-1.37.0.tar.bz2 | sha256sum -c - \
    && tar xf busybox-1.37.0.tar.bz2

WORKDIR /build/busybox-1.37.0

RUN make ARCH=riscv CROSS_COMPILE=riscv64-linux-musl- defconfig \
    && sed -i 's/^CONFIG_SHA1_HWACCEL=y/# CONFIG_SHA1_HWACCEL is not set/' .config \
    && sed -i 's/^CONFIG_SHA256_HWACCEL=y/# CONFIG_SHA256_HWACCEL is not set/' .config \
    && yes '' | make ARCH=riscv CROSS_COMPILE=riscv64-linux-musl- oldconfig \
    && make ARCH=riscv CROSS_COMPILE=riscv64-linux-musl- CONFIG_STATIC=y -j$(nproc) \
    && riscv64-linux-musl-strip busybox

FROM scratch

COPY --from=builder /build/busybox-1.37.0/busybox /busybox
