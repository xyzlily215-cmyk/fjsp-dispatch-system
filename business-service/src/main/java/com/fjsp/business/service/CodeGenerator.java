package com.fjsp.business.service;

import org.springframework.stereotype.Service;

@Service
public class CodeGenerator {

    public synchronized String next(String prefix, String maxCode) {
        int next = 1;
        if (maxCode != null) {
            int dash = maxCode.lastIndexOf('-');
            if (dash >= 0 && dash < maxCode.length() - 1) {
                try {
                    next = Integer.parseInt(maxCode.substring(dash + 1)) + 1;
                } catch (NumberFormatException ignored) {
                    next = 1;
                }
            }
        }
        return prefix + "-" + String.format("%03d", next);
    }
}
