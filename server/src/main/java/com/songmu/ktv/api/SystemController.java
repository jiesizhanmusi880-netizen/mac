package com.songmu.ktv.api;

import com.songmu.ktv.service.ToolLocator;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.Map;

@RestController
@RequestMapping("/api/system")
public class SystemController {

    private final ToolLocator tools;

    public SystemController(ToolLocator tools) {
        this.tools = tools;
    }

    @GetMapping("/tools")
    public Map<String, Object> tools() {
        return tools.status();
    }

    @GetMapping("/ping")
    public Map<String, Object> ping() {
        Map<String, Object> map = new LinkedHashMap<String, Object>();
        map.put("ok", true);
        map.put("service", "ktv-server");
        return map;
    }
}
