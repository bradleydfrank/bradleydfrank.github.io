---
title: "In-browser droplet contact angle measurement software"
author: Bradley Frank
pubDatetime: 2026-07-31T12:00:00Z
slug: dropletca
externalURL: /dropletca/
featured: true
draft: false
tags:
  - software
  - droptics
description: "The version of the tool I always wanted, without the need for proprietary software, or downloading. Perfect for use in a strictly managed IT environment."
---

**[Open the tool →](/dropletca/)**

Drop in a micrograph, click three points on the outer droplet edge and three on the
inner interface, and read off the contact angle, volume ratio, Janus ratio, surface
areas and geometry. Press <kbd>Enter</kbd> to accept a droplet and move straight on to
the next, then export the whole set as CSV.

It runs entirely in the browser. Nothing is uploaded, no server sees your images, and
there is no network traffic at all after the page loads — so it works offline, off a
USB stick, or in an environment where you cannot install anything.

This is a rewrite of the MATLAB tool from the supporting information of
[Djalali, Frank & Zeininger, _Soft Matter_ **16**, 10419 (2020)](https://doi.org/10.1039/D0SM01724H),
which needed a MATLAB licence and the Image Processing Toolbox. The geometry is pinned
to the original by 94 golden test cases generated from a line-by-line transcription of
the MATLAB source, with the refraction correction for the internal interface following
[Nagelberg et al., _Nat. Commun._ **8**, 14673 (2017)](https://doi.org/10.1038/ncomms14673).

Handles both spherical and non-spherical Janus morphologies, with optional µm-per-pixel
calibration.
