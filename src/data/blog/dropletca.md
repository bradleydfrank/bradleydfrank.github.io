---
title: "In-browser droplet contact angle measurement software"
author: Bradley Frank
pubDatetime: 2026-07-31T12:00:00Z
slug: dropletca
externalURL: /dropletca/
ogImage: ../../assets/images/dropletca-tool.png
featured: true
draft: false
tags:
  - tools
  - software
  - droptics
description: "The version of the tool I always wanted, without the need for proprietary software, or downloading. Perfect for use in a strictly managed IT environment."
---

**[Open the tool →](/dropletca/)**

Drag and drop a micrograph, click three points on the outer droplet edge and three on
the inner interface, and read off the contact angle, volume ratio, Janus ratio, surface
areas and geometry. Press <kbd>Enter</kbd> to accept a droplet and move straight on to
the next, then export the data as CSV.

It runs entirely in-browser. Nothing is uploaded, no server sees your images, and there
is no network traffic at all after the page loads, and no need to install anything.
This is especially helpful with difficult IT environments,…

This is a rewrite of the MATLAB tool from the supporting information of
[Djalali, Frank & Zeininger, _Soft Matter_ **16**, 10419 (2020)](https://doi.org/10.1039/D0SM01724H),
which needed a MATLAB licence and the Image Processing Toolbox. The refraction
correction for the internal interface following
[Nagelberg et al., _Nat. Commun._ **8**, 14673 (2017)](https://doi.org/10.1038/ncomms14673).

Handles both spherical and non-spherical Janus morphologies, with optional µm-per-pixel
calibration.
